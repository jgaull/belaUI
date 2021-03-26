/*
    belaUI - web UI for the BELABOX project
    Copyright (C) 2020-2021 BELABOX project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

const http = require('http');
const finalhandler = require('finalhandler');
const serveStatic = require('serve-static');
const ws = require('ws');
const { exec, spawn, spawnSync } = require("child_process");
const fs = require('fs')
const crypto = require('crypto');
const path = require('path');
const dns = require('dns');
const bcrypt = require('bcrypt');

const SETUP_FILE = 'setup.json';
const CONFIG_FILE = 'config.json';
const AUTH_TOKENS_FILE = 'auth_tokens.json';

const BCRYPT_ROUNDS = 10;


/* Read the config and setup files */
const setup = JSON.parse(fs.readFileSync(SETUP_FILE, 'utf8'));
console.log(setup);

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
// Update the password hash if the config file has a password set
if (config.password) {
  setPassword(config.password);
  delete config.password;
  saveConfig();
}
console.log(config);

function setPassword(password) {
  config.password_hash = bcrypt.hashSync(password, BCRYPT_ROUNDS);
}


/* tempTokens stores temporary login tokens in memory,
   persistentTokens stores login tokens to the disc */
const tempTokens = {};
let persistentTokens;
try {
  persistentTokens = JSON.parse(fs.readFileSync(AUTH_TOKENS_FILE, 'utf8'));
} catch(err) {
  persistentTokens = {};
}

function saveConfig() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

function savePersistentTokens() {
  fs.writeFileSync(AUTH_TOKENS_FILE, JSON.stringify(persistentTokens));
}


/* Misc helpers */
function buildMsg(type, data) {
  const obj = {};
  obj[type] = data;
  return JSON.stringify(obj);
}

function broadcastMsg(type, data) {
  const msg = buildMsg(type, data);
  for (const c of wss.clients) {
    if (c.isAuthed) c.send(msg);
  }
}

function broadcastMsgExcept(conn, type, data) {
  const msg = buildMsg(type, data);
  for (const c of wss.clients) {
    if (c != conn && c.isAuthed) c.send(msg);
  }
}


/* Read the list of pipeline files */
function read_dir_abs_path(dir) {
  const files = fs.readdirSync(dir);
  const basename = path.basename(dir);
  const pipelines = {};

  for (const f in files) {
    const name = basename + '/' + files[f];
    const id = crypto.createHash('sha1').update(name).digest('hex');
    const path = dir + files[f];
    pipelines[id] = {name: name, path: path};
  }

  return pipelines;
}

function getPipelines() {
  const ps = {};
  if (setup['hw'] == 'jetson') {
    Object.assign(ps, read_dir_abs_path(setup['belacoder_path'] + '/pipeline/jetson/'));
  }
  Object.assign(ps, read_dir_abs_path(setup['belacoder_path'] + '/pipeline/generic/'));

  return ps;
}

function searchPipelines(id) {
  const pipelines = getPipelines();
  if (pipelines[id]) return pipelines[id].path;
  return null;
}

// pipeline list in the format needed by the frontend
function getPipelineList() {
  const pipelines = getPipelines();
  const list = {};
  for (const id in pipelines) {
    list[id] = pipelines[id].name;
  }
  return list;
}


/* Network interface list */
let netif = {};
function updateNetif() {
  exec("ifconfig", (error, stdout, stderr) => {
    if (error) {
      console.log(error.message);
      return;
    }

    const newints = {};

    const interfaces = stdout.split("\n\n");
    for (const int of interfaces) {
      const name = int.split(':')[0]
      if (name == 'lo') continue;

      let inet_addr = int.match(/inet \d+\.\d+\.\d+\.\d+/);
      if (inet_addr == null) continue;
      inet_addr = inet_addr[0].split(' ')[1]

      let tx_bytes = int.match(/TX packets \d+  bytes \d+/);
      tx_bytes = parseInt(tx_bytes[0].split(' ').pop());
      if (netif[name]) {
        tp = tx_bytes - netif[name]['txb'];
      } else {
        tp = 0;
      }

      newints[name] = {ip: inet_addr, txb: tx_bytes, tp: tp};
    }
    netif = newints;

    broadcastMsg('netif', netif);
  });
}
updateNetif();
setInterval(updateNetif, 1000);


/* Streaming status */
let isStreaming = false;
function updateStatus() {
  exec("ps -aux |grep runner.rb |grep -v grep", (error, stdout, stderr) => {
    const streaming = (error == null);

    if (streaming != isStreaming) {
      isStreaming = streaming;
      broadcastMsg('status', {is_streaming: isStreaming});
    }
  });
}
updateStatus();
setInterval(updateStatus, 1000);


/* Websocket packet handlers */
function sendError(conn, msg) {
  conn.send(buildMsg('error', {msg: msg}));
}

function startError(conn, msg) {
  sendError(conn, msg);
  conn.send(buildMsg('status', {is_streaming: false}));
  return false;
}

function setBitrate(params) {
  if (params.min_br == undefined || params.max_br == undefined) return null;
  if (params.min_br < 500 || params.min_br > 12000) return null;
  if (params.max_br < 500 || params.max_br > 12000) return null;
  if (params.min_br > params.max_br) return null;

  config.min_br = params.min_br;
  config.max_br = params.max_br;
  saveConfig();

  fs.writeFileSync(setup.bitrate_file, params.min_br*1000 + "\n" + params.max_br*1000 + "\n");

  spawnSync("killall", ['-HUP', "belacoder"], { detached: true});

  return [params.min_br, params.max_br];
}

function updateConfig(conn, params, callback) {
  // delay
  if (params.delay == undefined)
    return startError(conn, "audio delay not specified");
  if (params.delay < -2000 || params.delay > 2000)
    return startError(conn, "invalid delay " + params.delay);

  // pipeline
  if (params.pipeline == undefined)
    return startError(conn, "pipeline not specified");
  let pipeline = searchPipelines(params.pipeline);
  if (pipeline == null)
    return startError(conn, "pipeline not found");

  // bitrate
  let bitrate = setBitrate(params);
  if (bitrate == null)
    return startError(conn, "invalid bitrate range: ");

  // srt latency
  if (params.srt_latency == undefined)
    return startError(conn, "SRT latency not specified");
  if (params.srt_latency < 100 || params.srt_latency > 10000)
    return startError(conn, "invalid SRT latency " + params.srt_latency + " ms");

  // srt streamid
  if (params.srt_streamid == undefined)
    return startError(conn, "SRT streamid not specified");

  // srtla addr & port
  if (params.srtla_addr == undefined)
    return startError(conn, "SRTLA address not specified");
  if (params.srtla_port == undefined)
    return startError(conn, "SRTLA port not specified");
  if (params.srtla_port <= 0 || params.srtla_port > 0xFFFF)
    return startError(conn, "invalid SRTLA port " + params.srtla_port);

  dns.lookup(params.srtla_addr, function(err, address, family) {
    if (err == null) {
      config.delay = params.delay;
      config.pipeline = params.pipeline;
      config.min_br = params.min_br;
      config.max_br = params.max_br;
      config.srt_latency = params.srt_latency;
      config.srt_streamid = params.srt_streamid;
      config.srtla_addr = params.srtla_addr;
      config.srtla_port = params.srtla_port;

      saveConfig();

      broadcastMsgExcept(conn, 'config', config);
      
      callback(pipeline);
    } else {
      startError(conn, "failed to resolve SRTLA addr " + params.srtla_addr);
    }
  });
}

function start(conn, params) {
  updateConfig(conn, params, function(pipeline) {
    spawn('ruby', ['runner.rb',
          pipeline,
          config.delay,
          config.srtla_addr,
          config.srtla_port,
          config.srt_latency,
          config.srt_streamid],
          { stdio: 'inherit' });
  });
}

function stop() {
  spawnSync("pkill", ["-f", "runner.rb"], {detached: true});
  spawnSync("killall", ["srtla_send"], {detached: true});
  spawnSync("killall", ["srtla_send_upstream"], {detached: true});
  spawnSync("killall", ["belacoder"], {detached: true});
}

function command(conn, cmd) {
  switch(cmd) {
    case 'poweroff':
      spawnSync("poweroff", {detached: true});
      break;
    case 'reboot':
      spawnSync("reboot", {detached: true});
      break;
  }
}


/* Authentication */
function genAuthToken(isPersistent) {
  const token = crypto.randomBytes(32).toString('base64');
  if (isPersistent) {
    persistentTokens[token] = true;
    savePersistentTokens();
  } else {
    tempTokens[token] = true;
  }
  return token;
}

function sendInitialStatus(conn) {
  conn.send(buildMsg('config', config));
  conn.send(buildMsg('pipelines', getPipelineList()));
  conn.send(buildMsg('status', {is_streaming: isStreaming}));
  conn.send(buildMsg('netif', netif));
}

function connAuth(conn, sendToken) {
  conn.isAuthed = true;
  let result = {success: true};
  if (sendToken != undefined) {
    result['auth_token'] = sendToken;
  }
  conn.send(buildMsg('auth', result));
  sendInitialStatus(conn);
}

function tryAuth(conn, msg) {
  if (typeof(msg.password) == 'string') {
    bcrypt.compare(msg.password, config.password_hash, function(err, match) {
      if (match == true && err == undefined) {
        conn.authToken = genAuthToken(msg.persistent_token);
        connAuth(conn, conn.authToken);
      } else {
        sendError(conn, "Invalid password");
      }
    });
  } else if (typeof(msg.token) == 'string') {
    if (tempTokens[msg.token] || persistentTokens[msg.token]) {
      connAuth(conn);
      conn.authToken = msg.token;
    } else {
      conn.send(buildMsg('auth', {success: false}));
    }
  }
}


function handleMessage(conn, msg) {
  for (const type in msg) {
    switch(type) {
      case 'auth':
        tryAuth(conn, msg[type]);
        break;
    }
  }

  if (!conn.isAuthed) return;

  for (const type in msg) {
    switch(type) {
      case 'start':
        start(conn, msg[type]);
        break;
      case 'stop':
        stop();
        break;
      case 'bitrate':
        if (isStreaming) {
          const br = setBitrate(msg[type]);
          if (br != null) {
            broadcastMsgExcept(conn, 'bitrate', {min_br: br[0], max_br: br[1]});
          }
        }
        break;
      case 'command':
        command(conn, msg[type]);
        break;
      case 'logout':
        if (conn.authToken) {
          delete tempTokens[conn.authToken];
          if (persistentTokens[conn.authToken]) {
            delete persistentTokens[conn.authToken];
            savePersistentTokens();
          }
        }
        delete conn.isAuthed;
        delete conn.authToken;

        break;
    }
  }
}


const staticHttp = serveStatic("public");

const server = http.createServer(function(req, res) {
  const done = finalhandler(req, res);
  staticHttp(req, res, done);
});

const wss = new ws.Server({ server });
wss.on('connection', function connection(conn) {
  conn.on('message', function incoming(msg) {
    console.log(msg);
    try {
      msg = JSON.parse(msg);
      handleMessage(conn, msg);
    } catch (err) {
      console.log(`Error parsing client message: ${err.message}`);
    }
  });
});


server.listen(80);
