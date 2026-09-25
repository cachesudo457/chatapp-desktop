const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'messages.json');
const ACCOUNTS_FILE = path.join(__dirname, 'accounts.json');
const SUGGESTIONS_FILE = path.join(__dirname, 'suggestions.json');
const ROOMS_FILE = path.join(__dirname, 'rooms.json');
const ROOM_MESSAGES_FILE = path.join(__dirname, 'room_messages.json');
const UNREAD_FILE = path.join(__dirname, 'unread.json');
const MAX_HISTORY = 500;
const DEFAULT_AVATAR = { type: 'text', value: '(ー_ー)' };
const MAX_AVATAR_IMAGE_BYTES = 1024 * 1024; // stored permanently on the account, so kept modest
const PUBLIC_ROOM_ID = 'public'; // the built-in, always-on shared room

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // no 0/O/1/l/I
function generatePassword(length = 10) {
  return Array.from(crypto.randomFillSync(new Uint8Array(length)))
    .map(b => PASSWORD_ALPHABET[b % PASSWORD_ALPHABET.length])
    .join('');
}

// ---- Admin ----
// Set ADMIN_PASSWORD as an environment variable on your host. If it's not
// set, a random one is generated each startup and printed to the server
// logs — fine for quick local testing, but set a real one in production.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (() => {
  const generated = generatePassword(14);
  console.log('No ADMIN_PASSWORD set — generated one for this session:', generated);
  console.log('Set ADMIN_PASSWORD as an environment variable to keep it stable across restarts.');
  return generated;
})();

// ---- Accounts: pick a name, get an auto-generated password ----
// The first time someone types a name, an account is created for it and a
// random password is generated and shown to them once. Typing that same
// name again requires that password. No email or third-party sign-in.
let accounts = {};
try {
  if (fs.existsSync(ACCOUNTS_FILE)) {
    accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read accounts, starting fresh:', e.message);
  accounts = {};
}

let accountsSaveQueued = false;
function saveAccounts() {
  if (accountsSaveQueued) return;
  accountsSaveQueued = true;
  setTimeout(() => {
    accountsSaveQueued = false;
    fs.writeFile(ACCOUNTS_FILE, JSON.stringify(accounts), err => {
      if (err) console.error('Failed to save accounts:', err.message);
    });
  }, 300);
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hash) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return attempt.length === expected.length && crypto.timingSafeEqual(attempt, expected);
}

// ---- Suggestions: a simple feedback box that only admins can read ----
let suggestions = [];
try {
  if (fs.existsSync(SUGGESTIONS_FILE)) {
    suggestions = JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read suggestions, starting fresh:', e.message);
  suggestions = [];
}

let suggestionsSaveQueued = false;
function saveSuggestions() {
  if (suggestionsSaveQueued) return;
  suggestionsSaveQueued = true;
  setTimeout(() => {
    suggestionsSaveQueued = false;
    fs.writeFile(SUGGESTIONS_FILE, JSON.stringify(suggestions), err => {
      if (err) console.error('Failed to save suggestions:', err.message);
    });
  }, 300);
}

// ---- Rooms: custom named chats, each public or private ----
// rooms[roomId] = { id, name, ownerName, public, members: [names], createdAt }
// The built-in "Public Chat" (PUBLIC_ROOM_ID) is not stored here — it
// always exists and uses the original messages.json/history mechanism
// from earlier stages, untouched.
let rooms = {};
try {
  if (fs.existsSync(ROOMS_FILE)) {
    rooms = JSON.parse(fs.readFileSync(ROOMS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read rooms, starting fresh:', e.message);
  rooms = {};
}
let roomsSaveQueued = false;
function saveRooms() {
  if (roomsSaveQueued) return;
  roomsSaveQueued = true;
  setTimeout(() => {
    roomsSaveQueued = false;
    fs.writeFile(ROOMS_FILE, JSON.stringify(rooms), err => {
      if (err) console.error('Failed to save rooms:', err.message);
    });
  }, 300);
}

// roomMessages[roomId] = [ {id, name, text, ts, attachment?}, ... ]
let roomMessages = {};
try {
  if (fs.existsSync(ROOM_MESSAGES_FILE)) {
    roomMessages = JSON.parse(fs.readFileSync(ROOM_MESSAGES_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read room messages, starting fresh:', e.message);
  roomMessages = {};
}
let roomMessagesSaveQueued = false;
function saveRoomMessages() {
  if (roomMessagesSaveQueued) return;
  roomMessagesSaveQueued = true;
  setTimeout(() => {
    roomMessagesSaveQueued = false;
    fs.writeFile(ROOM_MESSAGES_FILE, JSON.stringify(roomMessages), err => {
      if (err) console.error('Failed to save room messages:', err.message);
    });
  }, 300);
}

// unread[memberNameLower][roomId] = count of messages missed while away
let unread = {};
try {
  if (fs.existsSync(UNREAD_FILE)) {
    unread = JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read unread counts, starting fresh:', e.message);
  unread = {};
}
let unreadSaveQueued = false;
function saveUnread() {
  if (unreadSaveQueued) return;
  unreadSaveQueued = true;
  setTimeout(() => {
    unreadSaveQueued = false;
    fs.writeFile(UNREAD_FILE, JSON.stringify(unread), err => {
      if (err) console.error('Failed to save unread counts:', err.message);
    });
  }, 300);
}
function bumpUnread(memberName, roomId) {
  const key = memberName.toLowerCase();
  if (!unread[key]) unread[key] = {};
  unread[key][roomId] = (unread[key][roomId] || 0) + 1;
  saveUnread();
}
function clearUnread(memberName, roomId) {
  const key = memberName.toLowerCase();
  if (unread[key] && unread[key][roomId]) {
    delete unread[key][roomId];
    saveUnread();
  }
}

// Accounts created before friends existed won't have these fields yet —
// backfill them on access so nothing crashes on older data.
function getAccount(name) {
  const key = String(name || '').trim().toLowerCase();
  const account = accounts[key];
  if (!account) return null;
  if (!account.friends) account.friends = [];
  if (!account.incomingRequests) account.incomingRequests = [];
  if (!account.outgoingRequests) account.outgoingRequests = [];
  return account;
}

function roomIsMember(room, name) {
  return room.members.some(n => n.toLowerCase() === name.toLowerCase());
}

function canAccessRoom(room, name) {
  if (!room) return false;
  if (room.public) return true;
  return roomIsMember(room, name);
}

function roomSummary(room) {
  return { id: room.id, name: room.name, public: room.public, ownerName: room.ownerName, members: room.members };
}

// ---- Profanity filter ----
const SWEAR_WORDS = [
  'fuck', 'fucks', 'fucking', 'fucked', 'fucker', 'fuckers', 'fuckface', 'motherfucker', 'motherfuckers', 'fuk', 'fuking', 'fukin',
  'shit', 'shits', 'shitty', 'shitting', 'shitted', 'bullshit', 'horseshit', 'sh1t', 'shite',
  'bitch', 'bitches', 'bitching', 'b1tch',
  'bastard', 'bastards',
  'asshole', 'assholes', 'ass', 'asses', 'a55', 'jackass', 'dumbass',
  'dick', 'dicks', 'dickhead', 'dickheads',
  'piss', 'pissed', 'pissing',
  'crap', 'crappy', 'crapped',
  'damn', 'damned', 'dammit', 'goddamn', 'goddammit', 'goddamned',
  'bollocks', 'bollix',
  'bugger', 'buggered', 'buggering',
  'wanker', 'wankers', 'wanking',
  'twat', 'twats',
  'slut', 'sluts', 'slutty',
  'whore', 'whores', 'whoring',
  'douche', 'douchebag', 'douchebags',
  'prick', 'pricks',
  'cock', 'cocks', 'cocksucker', 'cocksuckers',
  'arse', 'arsehole'
];
const swearPattern = new RegExp('\\b(' + SWEAR_WORDS.join('|') + ')\\b', 'gi');
function censor(text) {
  return text.replace(swearPattern, m => '*'.repeat(m.length));
}

// ---- Message history persistence ----
let history = [];
try {
  if (fs.existsSync(DATA_FILE)) {
    history = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
} catch (e) {
  console.error('Could not read message history, starting fresh:', e.message);
  history = [];
}

let saveQueued = false;
function saveHistory() {
  if (saveQueued) return;
  saveQueued = true;
  setTimeout(() => {
    saveQueued = false;
    fs.writeFile(DATA_FILE, JSON.stringify(history), err => {
      if (err) console.error('Failed to save history:', err.message);
    });
  }, 300);
}

// ---- Server setup ----
const app = express();
app.use(express.json());

// Serve the chat page explicitly, checking a couple of likely locations —
// some hosting platforms don't preserve the public/ subfolder exactly when
// files are uploaded or pasted in through a browser editor.
const indexCandidates = [
  path.join(__dirname, 'public', 'index.html'),
  path.join(__dirname, 'index.html')
];
const indexPath = indexCandidates.find(p => fs.existsSync(p));

app.get('/', (req, res) => {
  if (!indexPath) {
    res.status(500).send('index.html not found. Make sure index.html is in this project (in a "public" folder, or at the project root).');
    return;
  }
  res.sendFile(indexPath);
});

// Still serve the public/ folder normally in case other assets are added later.
app.use(express.static(path.join(__dirname, 'public')));

// Serves the desktop app installers, if you've built and placed them here.
// See downloads/README.md for exactly what to name the files.
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
app.use('/downloads', express.static(DOWNLOADS_DIR));

app.get('/download', (req, res) => {
  const winFile = 'The-Room-Setup.exe';
  const macFile = 'The-Room.dmg';
  const hasWin = fs.existsSync(path.join(DOWNLOADS_DIR, winFile));
  const hasMac = fs.existsSync(path.join(DOWNLOADS_DIR, macFile));

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Download — The Room</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", system-ui, sans-serif;
    background: #faf6ef; color: #4a453d; padding: 24px;
  }
  .card { max-width: 380px; text-align: center; }
  .avatar { width: 64px; height: 64px; border-radius: 50%; background: #e6e2f5; display: flex;
    align-items: center; justify-content: center; font-size: 15px; margin: 0 auto 16px; }
  h1 { font-size: 19px; margin: 0 0 8px; }
  p { color: #9b9488; font-size: 13.5px; line-height: 1.6; margin: 0 0 24px; }
  .btn { display: block; background: #8ba888; color: #fff; text-decoration: none; font-weight: 700;
    font-size: 14px; padding: 13px; border-radius: 24px; margin-bottom: 12px; }
  .btn:hover { background: #6d8a6b; }
  .btn.disabled { background: #e9e1d3; color: #9b9488; pointer-events: none; }
  .back { color: #9b9488; font-size: 12.5px; text-decoration: underline; }
</style>
</head>
<body>
  <div class="card">
    <div class="avatar">(ー_ー)</div>
    <h1>Download The Room</h1>
    <p>Get the desktop app for a native window instead of a browser tab.</p>
    <a class="btn ${hasWin ? '' : 'disabled'}" href="/downloads/${winFile}">${hasWin ? 'Download for Windows' : 'Windows build coming soon'}</a>
    <a class="btn ${hasMac ? '' : 'disabled'}" href="/downloads/${macFile}">${hasMac ? 'Download for Mac' : 'Mac build coming soon'}</a>
    <a class="back" href="/">Back to the chat</a>
  </div>
</body>
</html>`);
});

const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5 * 1024 * 1024 // allow up to ~5MB payloads for file attachments
});

// name -> socket id, so we know who is currently online / typing
const typingUsers = new Map(); // name -> timeout handle
const activeSockets = new Map(); // name -> currently connected socket (for kicking on ban)
const calls = new Map(); // callId -> { members: Map(name -> { avatar, status }) }
const activeCallOf = new Map(); // name -> callId, so nobody's in two calls at once

function notify(name, event, payload) {
  const s = activeSockets.get(name);
  if (s) s.emit(event, payload);
}
const RESERVED_NAMES = ['admin', 'announcement']; // can't be claimed as a regular account name

io.on('connection', socket => {
  let authedName = null;
  let currentRoomId = null; // room the client currently has open (for scoping broadcasts)

  const MIN_PASSWORD_LENGTH = 4;

  function validatePassword(pw) {
    const clean = String(pw || '').trim();
    if (clean.length < MIN_PASSWORD_LENGTH) {
      return `Password needs to be at least ${MIN_PASSWORD_LENGTH} characters.`;
    }
    return null;
  }

  // One combined login: existing name -> verify the typed password;
  // new name -> create the account using the typed password. The person
  // always chooses their own password, both at signup and going forward.
  socket.on('login', ({ name, password }) => {
    const clean = String(name || '').trim().slice(0, 24);
    if (!clean) {
      socket.emit('login-error', 'Enter a name to use in the chat.');
      return;
    }
    const key = clean.toLowerCase();
    if (RESERVED_NAMES.includes(key)) {
      socket.emit('login-error', 'That name is reserved. Please pick another.');
      return;
    }
    const cleanPassword = String(password || '').trim();
    const existing = accounts[key];

    if (!existing) {
      const pwError = validatePassword(cleanPassword);
      if (pwError) {
        socket.emit('login-error', pwError);
        return;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      accounts[key] = {
        name: clean,
        salt,
        hash: hashPassword(cleanPassword, salt),
        createdAt: Date.now(),
        avatar: DEFAULT_AVATAR,
        friends: [],
        incomingRequests: [],
        outgoingRequests: []
      };
      saveAccounts();
      authedName = clean;
      socket.data.name = clean;
      activeSockets.set(clean, socket);
      socket.emit('login-success', {
        name: clean,
        history: history.slice(-MAX_HISTORY),
        avatar: accounts[key].avatar,
        isNewAccount: true
      });
      return;
    }

    if (!cleanPassword || !verifyPassword(cleanPassword, existing.salt, existing.hash)) {
      socket.emit('login-error', "That name and password don't match.");
      return;
    }
    authedName = existing.name;
    socket.data.name = existing.name;
    activeSockets.set(existing.name, socket);
    socket.emit('login-success', {
      name: existing.name,
      history: history.slice(-MAX_HISTORY),
      avatar: existing.avatar || DEFAULT_AVATAR,
      isNewAccount: false
    });
  });

  // Self-service recovery from the login gate: type a name and a NEW
  // password of your choosing, and get logged straight in with it. No
  // other verification — see the caveat about this in README.md.
  socket.on('recover-password', ({ name, password }) => {
    const key = String(name || '').trim().toLowerCase();
    const account = accounts[key];
    if (!account) {
      socket.emit('recovery-error', 'No account with that name.');
      return;
    }
    const pwError = validatePassword(password);
    if (pwError) {
      socket.emit('recovery-error', pwError);
      return;
    }
    const cleanPassword = String(password).trim();
    const salt = crypto.randomBytes(16).toString('hex');
    account.salt = salt;
    account.hash = hashPassword(cleanPassword, salt);
    saveAccounts();
    authedName = account.name;
    socket.data.name = account.name;
    activeSockets.set(account.name, socket);
    socket.emit('login-success', {
      name: account.name,
      history: history.slice(-MAX_HISTORY),
      avatar: account.avatar || DEFAULT_AVATAR,
      isNewAccount: false
    });
  });

  // Self-service change from inside the dashboard, while already logged in.
  socket.on('change-my-password', ({ password }) => {
    if (!authedName) return;
    const key = authedName.toLowerCase();
    const account = accounts[key];
    if (!account) return;
    const pwError = validatePassword(password);
    if (pwError) {
      socket.emit('password-change-error', pwError);
      return;
    }
    const cleanPassword = String(password).trim();
    const salt = crypto.randomBytes(16).toString('hex');
    account.salt = salt;
    account.hash = hashPassword(cleanPassword, salt);
    saveAccounts();
    socket.emit('password-changed');
  });

  socket.on('message', ({ text, attachment }) => {
    if (!authedName) return;
    const clean = (text || '').toString().slice(0, 2000);
    if (!clean.trim() && !attachment) return;
    const payload = {
      id: crypto.randomBytes(8).toString('hex'),
      name: authedName,
      text: clean ? censor(clean) : '',
      ts: Date.now()
    };
    if (attachment && attachment.dataUrl && attachment.filename) {
      // basic sanity limit on stored attachment size
      if (attachment.dataUrl.length < 7 * 1024 * 1024) {
        payload.attachment = {
          filename: String(attachment.filename).slice(0, 200),
          mime: String(attachment.mime || 'application/octet-stream').slice(0, 100),
          dataUrl: attachment.dataUrl
        };
      }
    }
    history.push(payload);
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    saveHistory();
    io.emit('message', payload);
  });

  socket.on('delete', ({ id }) => {
    if (!authedName) return;
    const msg = history.find(m => m.id === id);
    if (!msg || msg.name !== authedName) return;
    history = history.filter(m => m.id !== id);
    saveHistory();
    io.emit('deleted', { id });
  });

  socket.on('set-avatar', ({ type, dataUrl, mime }) => {
    if (!authedName) return;
    const key = authedName.toLowerCase();
    const account = accounts[key];
    if (!account) return;

    if (type === 'reset') {
      account.avatar = DEFAULT_AVATAR;
    } else if (type === 'image') {
      if (!dataUrl || typeof dataUrl !== 'string' || dataUrl.length > MAX_AVATAR_IMAGE_BYTES * 1.4) {
        socket.emit('profile-error', { field: 'avatar', message: 'That image is too big. Try something under 1MB.' });
        return;
      }
      account.avatar = { type: 'image', dataUrl, mime: String(mime || 'image/png').slice(0, 60) };
    } else {
      socket.emit('profile-error', { field: 'avatar', message: 'Unrecognized avatar type.' });
      return;
    }
    saveAccounts();
    socket.emit('profile-updated', { avatar: account.avatar });
  });

  socket.on('submit-suggestion', ({ text }) => {
    if (!authedName) return;
    const clean = String(text || '').trim().slice(0, 1000);
    if (!clean) {
      socket.emit('suggestion-error', 'Write something before sending.');
      return;
    }
    suggestions.push({
      id: crypto.randomBytes(8).toString('hex'),
      name: authedName,
      text: clean,
      ts: Date.now()
    });
    saveSuggestions();
    socket.emit('suggestion-submitted');
  });

  socket.on('get-friend-data', () => {
    if (!authedName) return;
    const me = getAccount(authedName);
    if (!me) return;
    socket.emit('friend-data', {
      friends: me.friends,
      incoming: me.incomingRequests,
      outgoing: me.outgoingRequests
    });
  });

  socket.on('send-friend-request', ({ name: toName }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const target = getAccount(toName);
    const requestedName = String(toName || '').trim();
    if (!target) {
      socket.emit('friend-error', 'No account with that name.');
      return;
    }
    if (target.name.toLowerCase() === me.name.toLowerCase()) {
      socket.emit('friend-error', "You can't friend yourself.");
      return;
    }
    if (me.friends.some(n => n.toLowerCase() === target.name.toLowerCase())) {
      socket.emit('friend-error', 'You are already friends.');
      return;
    }
    if (me.outgoingRequests.some(n => n.toLowerCase() === target.name.toLowerCase())) {
      socket.emit('friend-error', 'Request already sent.');
      return;
    }
    // They already sent me a request — sending one back just accepts it.
    if (me.incomingRequests.some(n => n.toLowerCase() === target.name.toLowerCase())) {
      me.incomingRequests = me.incomingRequests.filter(n => n.toLowerCase() !== target.name.toLowerCase());
      target.outgoingRequests = target.outgoingRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
      me.friends.push(target.name);
      target.friends.push(me.name);
      saveAccounts();
      socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
      notify(target.name, 'friend-data', { friends: target.friends, incoming: target.incomingRequests, outgoing: target.outgoingRequests });
      notify(target.name, 'friend-accepted', { name: me.name });
      return;
    }
    me.outgoingRequests.push(target.name);
    target.incomingRequests.push(me.name);
    saveAccounts();
    socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
    notify(target.name, 'friend-data', { friends: target.friends, incoming: target.incomingRequests, outgoing: target.outgoingRequests });
    notify(target.name, 'friend-request-received', { from: me.name });
  });

  socket.on('accept-friend-request', ({ name: fromName }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const requester = getAccount(fromName);
    if (!requester || !me.incomingRequests.some(n => n.toLowerCase() === requester.name.toLowerCase())) {
      socket.emit('friend-error', 'That request no longer exists.');
      return;
    }
    me.incomingRequests = me.incomingRequests.filter(n => n.toLowerCase() !== requester.name.toLowerCase());
    requester.outgoingRequests = requester.outgoingRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
    me.friends.push(requester.name);
    requester.friends.push(me.name);
    saveAccounts();
    socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
    notify(requester.name, 'friend-data', { friends: requester.friends, incoming: requester.incomingRequests, outgoing: requester.outgoingRequests });
    notify(requester.name, 'friend-accepted', { name: me.name });
  });

  socket.on('decline-friend-request', ({ name: fromName }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const requester = getAccount(fromName);
    if (!requester) return;
    me.incomingRequests = me.incomingRequests.filter(n => n.toLowerCase() !== requester.name.toLowerCase());
    requester.outgoingRequests = requester.outgoingRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
    saveAccounts();
    socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
    notify(requester.name, 'friend-data', { friends: requester.friends, incoming: requester.incomingRequests, outgoing: requester.outgoingRequests });
  });

  socket.on('cancel-friend-request', ({ name: toName }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const target = getAccount(toName);
    if (!target) return;
    me.outgoingRequests = me.outgoingRequests.filter(n => n.toLowerCase() !== target.name.toLowerCase());
    target.incomingRequests = target.incomingRequests.filter(n => n.toLowerCase() !== me.name.toLowerCase());
    saveAccounts();
    socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
    notify(target.name, 'friend-data', { friends: target.friends, incoming: target.incomingRequests, outgoing: target.outgoingRequests });
  });

  socket.on('remove-friend', ({ name: otherName }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const other = getAccount(otherName);
    if (!other) return;
    me.friends = me.friends.filter(n => n.toLowerCase() !== other.name.toLowerCase());
    other.friends = other.friends.filter(n => n.toLowerCase() !== me.name.toLowerCase());
    saveAccounts();
    socket.emit('friend-data', { friends: me.friends, incoming: me.incomingRequests, outgoing: me.outgoingRequests });
    notify(other.name, 'friend-data', { friends: other.friends, incoming: other.incomingRequests, outgoing: other.outgoingRequests });
  });

  // ---- Voice calls (group-capable, WebRTC mesh — this just relays the signaling) ----
  // A call is: { members: Map(name -> { avatar, status: 'invited'|'joined' }) }
  // activeCallOf: name -> callId, so nobody's in two calls at once.
  function callRosterFor(callId) {
    const call = calls.get(callId);
    if (!call) return [];
    return [...call.members.entries()].map(([n, m]) => ({ name: n, avatar: m.avatar, status: m.status }));
  }

  function leaveCall(myName, reason) {
    const callId = activeCallOf.get(myName);
    if (!callId) return;
    const call = calls.get(callId);
    activeCallOf.delete(myName);
    if (!call) return;
    call.members.delete(myName);
    call.members.forEach((m, otherName) => {
      notify(otherName, 'call-participant-left', { callId, name: myName, reason: reason || 'left' });
    });
    if (call.members.size === 0) calls.delete(callId);
  }

  socket.on('start-call', ({ participantNames }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    if (activeCallOf.has(me.name)) {
      socket.emit('call-error', { message: "You're already on a call." });
      return;
    }
    const requested = Array.isArray(participantNames) ? participantNames : [];
    const targets = [];
    const unreachable = [];
    requested.forEach(rawName => {
      const target = getAccount(rawName);
      if (!target || target.name.toLowerCase() === me.name.toLowerCase()) return;
      if (!me.friends.some(n => n.toLowerCase() === target.name.toLowerCase())) return; // only friends
      if (!activeSockets.has(target.name) || activeCallOf.has(target.name)) {
        unreachable.push(target.name);
      } else {
        targets.push(target);
      }
    });
    if (targets.length === 0) {
      socket.emit('call-error', { message: unreachable.length ? `Nobody could be reached (${unreachable.join(', ')}).` : 'Pick at least one friend to call.' });
      return;
    }
    const callId = crypto.randomBytes(8).toString('hex');
    const members = new Map();
    members.set(me.name, { avatar: me.avatar, status: 'joined' });
    calls.set(callId, { members });
    activeCallOf.set(me.name, callId);
    targets.forEach(target => {
      members.set(target.name, { avatar: target.avatar, status: 'invited' });
      activeCallOf.set(target.name, callId);
      notify(target.name, 'incoming-call', { callId, from: me.name, avatar: me.avatar, roster: callRosterFor(callId) });
    });
    socket.emit('call-started', { callId, roster: callRosterFor(callId), unreachable });
  });

  socket.on('call-response', ({ callId, accept }) => {
    if (!authedName) return;
    const me = getAccount(authedName);
    const call = calls.get(callId);
    const membership = call && call.members.get(authedName);
    if (!call || !membership || membership.status !== 'invited') return;
    if (accept) {
      membership.status = 'joined';
      // Tell the newcomer who's already in the call, so it can connect out to each of them.
      socket.emit('call-roster', { callId, roster: callRosterFor(callId) });
      call.members.forEach((m, otherName) => {
        if (otherName === authedName) return;
        notify(otherName, 'call-participant-joined', { callId, name: authedName, avatar: me.avatar });
      });
    } else {
      leaveCall(authedName, 'declined');
    }
  });

  socket.on('call-signal', ({ callId, to, data }) => {
    if (!authedName) return;
    const call = calls.get(callId);
    if (!call || !call.members.has(authedName) || !call.members.has(to)) return;
    notify(to, 'call-signal', { callId, from: authedName, data });
  });

  socket.on('call-leave', ({ callId }) => {
    if (!authedName) return;
    if (activeCallOf.get(authedName) === callId) leaveCall(authedName, 'left');
  });

  // ---- Rooms ----

  socket.on('create-room', ({ name: roomName, isPublic }) => {
    if (!authedName) return;
    const clean = String(roomName || '').trim().slice(0, 40);
    if (!clean) {
      socket.emit('room-error', 'Give the room a name.');
      return;
    }
    const id = crypto.randomBytes(6).toString('hex');
    const room = {
      id,
      name: censor(clean),
      ownerName: authedName,
      public: !!isPublic,
      members: [authedName],
      createdAt: Date.now()
    };
    rooms[id] = room;
    roomMessages[id] = [];
    saveRooms();
    saveRoomMessages();
    socket.emit('room-created', { room: roomSummary(room) });
    if (room.public) {
      socket.broadcast.emit('public-room-added', { room: roomSummary(room) });
    }
  });

  socket.on('list-my-rooms', () => {
    if (!authedName) return;
    const mine = Object.values(rooms)
      .filter(r => roomIsMember(r, authedName))
      .map(r => Object.assign(roomSummary(r), { unread: (unread[authedName.toLowerCase()] || {})[r.id] || 0 }));
    socket.emit('my-rooms', { rooms: mine });
  });

  socket.on('list-public-rooms', () => {
    if (!authedName) return;
    const browsable = Object.values(rooms)
      .filter(r => r.public && !roomIsMember(r, authedName))
      .map(roomSummary);
    socket.emit('public-rooms', { rooms: browsable });
  });

  socket.on('join-public-room', ({ roomId }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!room || !room.public) {
      socket.emit('room-error', 'That room is not available.');
      return;
    }
    if (!roomIsMember(room, authedName)) {
      room.members.push(authedName);
      saveRooms();
    }
    socket.emit('room-joined', { room: roomSummary(room) });
  });

  socket.on('enter-room', ({ roomId }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!canAccessRoom(room, authedName)) {
      socket.emit('room-error', "You don't have access to that room.");
      return;
    }
    if (currentRoomId && currentRoomId !== roomId) {
      socket.leave(currentRoomId);
    }
    socket.join(roomId);
    currentRoomId = roomId;
    clearUnread(authedName, roomId);
    socket.emit('room-entered', {
      room: roomSummary(room),
      messages: (roomMessages[roomId] || []).slice(-MAX_HISTORY)
    });
  });

  socket.on('leave-room-view', () => {
    if (currentRoomId) {
      socket.leave(currentRoomId);
      currentRoomId = null;
    }
  });

  socket.on('room-message', ({ roomId, text, attachment }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!canAccessRoom(room, authedName)) return;
    const clean = (text || '').toString().slice(0, 2000);
    if (!clean.trim() && !attachment) return;
    const payload = {
      id: crypto.randomBytes(8).toString('hex'),
      name: authedName,
      text: clean ? censor(clean) : '',
      ts: Date.now()
    };
    if (attachment && attachment.dataUrl && attachment.filename && attachment.dataUrl.length < 7 * 1024 * 1024) {
      payload.attachment = {
        filename: String(attachment.filename).slice(0, 200),
        mime: String(attachment.mime || 'application/octet-stream').slice(0, 100),
        dataUrl: attachment.dataUrl
      };
    }
    if (!roomMessages[roomId]) roomMessages[roomId] = [];
    roomMessages[roomId].push(payload);
    if (roomMessages[roomId].length > MAX_HISTORY) roomMessages[roomId] = roomMessages[roomId].slice(-MAX_HISTORY);
    saveRoomMessages();

    io.to(roomId).emit('room-message', { roomId, message: payload });

    // Anyone who's a member but not actively viewing this room right now
    // gets an unread bump instead of the live message.
    const viewerSockets = io.sockets.adapter.rooms.get(roomId) || new Set();
    room.members.forEach(memberName => {
      if (memberName.toLowerCase() === authedName.toLowerCase()) return;
      const memberSocket = activeSockets.get(memberName);
      const isViewing = memberSocket && viewerSockets.has(memberSocket.id);
      if (!isViewing) {
        bumpUnread(memberName, roomId);
        if (memberSocket) {
          memberSocket.emit('unread-bump', { roomId, name: room.name });
        }
      }
    });
  });

  socket.on('room-typing', ({ roomId }) => {
    if (!authedName || currentRoomId !== roomId) return;
    socket.to(roomId).emit('room-typing', { roomId, name: authedName });
  });

  socket.on('room-stop-typing', ({ roomId }) => {
    if (!authedName) return;
    socket.to(roomId).emit('room-stop-typing', { roomId, name: authedName });
  });

  socket.on('room-delete-message', ({ roomId, id }) => {
    if (!authedName) return;
    const list = roomMessages[roomId];
    if (!list) return;
    const msg = list.find(m => m.id === id);
    if (!msg || msg.name !== authedName) return;
    roomMessages[roomId] = list.filter(m => m.id !== id);
    saveRoomMessages();
    io.to(roomId).emit('room-message-deleted', { roomId, id });
  });

  socket.on('delete-room', ({ roomId }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!room || room.ownerName.toLowerCase() !== authedName.toLowerCase()) {
      socket.emit('room-error', 'Only the room owner can delete it.');
      return;
    }
    const members = room.members.slice();
    delete rooms[roomId];
    delete roomMessages[roomId];
    saveRooms();
    saveRoomMessages();
    members.forEach(memberName => {
      delete (unread[memberName.toLowerCase()] || {})[roomId];
      notify(memberName, 'room-removed', { roomId });
    });
    saveUnread();
    io.to(roomId).emit('room-removed', { roomId });
  });

  socket.on('add-room-member', ({ roomId, name: addName }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!room || room.ownerName.toLowerCase() !== authedName.toLowerCase()) {
      socket.emit('room-error', 'Only the room owner can add members.');
      return;
    }
    const target = getAccount(addName);
    if (!target) {
      socket.emit('room-error', 'No account with that name.');
      return;
    }
    if (!roomIsMember(room, target.name)) {
      room.members.push(target.name);
      saveRooms();
      notify(target.name, 'added-to-room', { room: roomSummary(room) });
    }
    socket.emit('room-updated', { room: roomSummary(room) });
  });

  socket.on('remove-room-member', ({ roomId, name: removeName }) => {
    if (!authedName) return;
    const room = rooms[roomId];
    if (!room || room.ownerName.toLowerCase() !== authedName.toLowerCase()) {
      socket.emit('room-error', 'Only the room owner can remove members.');
      return;
    }
    if (removeName.toLowerCase() === room.ownerName.toLowerCase()) {
      socket.emit('room-error', "The owner can't be removed.");
      return;
    }
    room.members = room.members.filter(n => n.toLowerCase() !== removeName.toLowerCase());
    saveRooms();
    const removedSocket = activeSockets.get(removeName);
    if (removedSocket) {
      removedSocket.emit('room-removed', { roomId });
      removedSocket.leave(roomId);
    }
    socket.emit('room-updated', { room: roomSummary(room) });
  });

  socket.on('get-notifications', () => {
    if (!authedName) return;
    const myUnread = unread[authedName.toLowerCase()] || {};
    const items = Object.entries(myUnread)
      .filter(([, count]) => count > 0)
      .map(([roomId, count]) => ({
        roomId,
        count,
        name: rooms[roomId] ? rooms[roomId].name : '(deleted room)'
      }));
    socket.emit('notifications', { items });
  });

  socket.on('typing', () => {
    if (!authedName) return;
    socket.broadcast.emit('typing', { name: authedName });
  });

  socket.on('stop-typing', () => {
    if (!authedName) return;
    socket.broadcast.emit('stop-typing', { name: authedName });
  });

  socket.on('disconnect', () => {
    if (authedName) {
      socket.broadcast.emit('stop-typing', { name: authedName });
      if (activeSockets.get(authedName) === socket) {
        activeSockets.delete(authedName);
      }
      leaveCall(authedName, 'left');
    }
    currentRoomId = null;
  });
});

// ---- Admin API ----
// Simple header-based check — fine for a small group's private tool.
// Every admin request must include: x-admin-password: <ADMIN_PASSWORD>
function requireAdmin(req, res, next) {
  const supplied = req.get('x-admin-password') || '';
  const a = Buffer.from(supplied);
  const b = Buffer.from(ADMIN_PASSWORD);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    res.status(401).json({ error: 'Wrong admin password.' });
    return;
  }
  next();
}

const adminIndexCandidates = [
  path.join(__dirname, 'public', 'admin.html'),
  path.join(__dirname, 'admin.html')
];
const adminIndexPath = adminIndexCandidates.find(p => fs.existsSync(p));

app.get('/admin', (req, res) => {
  if (!adminIndexPath) {
    res.status(500).send('admin.html not found.');
    return;
  }
  res.sendFile(adminIndexPath);
});

app.post('/admin/api/check', requireAdmin, (req, res) => {
  res.json({ ok: true });
});

app.get('/admin/api/users', requireAdmin, (req, res) => {
  const users = Object.values(accounts).map(a => ({
    name: a.name,
    createdAt: a.createdAt || null,
    online: activeSockets.has(a.name)
  })).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ users });
});

app.get('/admin/api/suggestions', requireAdmin, (req, res) => {
  const sorted = [...suggestions].sort((a, b) => b.ts - a.ts);
  res.json({ suggestions: sorted });
});

// Permanently deletes an account: kicks them if online, removes their
// membership from every room (deleting rooms they own outright), strips
// them from everyone else's friends/requests, and clears their unread
// counts. Their message history is left intact, still attributed to
// their old name — only the account and its access are removed. Once
// deleted, that name becomes claimable again by anyone.
app.post('/admin/api/delete-user', requireAdmin, (req, res) => {
  const key = String(req.body.name || '').trim().toLowerCase();
  const account = accounts[key];
  if (!account) {
    res.status(404).json({ error: 'No account with that name.' });
    return;
  }
  const deletedName = account.name;

  const activeSocket = activeSockets.get(deletedName);
  if (activeSocket) {
    activeSocket.emit('account-deleted');
    activeSocket.disconnect(true);
    activeSockets.delete(deletedName);
  }

  Object.values(rooms).forEach(room => {
    if (room.ownerName.toLowerCase() === key) {
      const members = room.members.slice();
      delete rooms[room.id];
      delete roomMessages[room.id];
      members.forEach(m => {
        if (unread[m.toLowerCase()]) delete unread[m.toLowerCase()][room.id];
        notify(m, 'room-removed', { roomId: room.id });
      });
    } else if (roomIsMember(room, deletedName)) {
      room.members = room.members.filter(n => n.toLowerCase() !== key);
    }
  });
  saveRooms();
  saveRoomMessages();

  Object.values(accounts).forEach(a => {
    if (a === account) return;
    a.friends = (a.friends || []).filter(n => n.toLowerCase() !== key);
    a.incomingRequests = (a.incomingRequests || []).filter(n => n.toLowerCase() !== key);
    a.outgoingRequests = (a.outgoingRequests || []).filter(n => n.toLowerCase() !== key);
  });

  delete unread[key];
  delete accounts[key];
  saveAccounts();
  saveUnread();

  res.json({ ok: true });
});

app.get('/admin/api/rooms', requireAdmin, (req, res) => {
  const list = Object.values(rooms).map(r => ({
    id: r.id,
    name: r.name,
    public: r.public,
    ownerName: r.ownerName,
    memberCount: r.members.length,
    createdAt: r.createdAt
  })).sort((a, b) => b.createdAt - a.createdAt);
  res.json({ rooms: list });
});

app.get('/admin/api/chat/public', requireAdmin, (req, res) => {
  res.json({ name: 'Public Chat', messages: history.slice(-MAX_HISTORY) });
});

app.get('/admin/api/chat/:roomId', requireAdmin, (req, res) => {
  const room = rooms[req.params.roomId];
  if (!room) {
    res.status(404).json({ error: 'Room not found.' });
    return;
  }
  res.json({ name: room.name, messages: (roomMessages[room.id] || []).slice(-MAX_HISTORY) });
});

app.post('/admin/api/reset-password', requireAdmin, (req, res) => {
  const key = String(req.body.name || '').trim().toLowerCase();
  const account = accounts[key];
  if (!account) {
    res.status(404).json({ error: 'No account with that name.' });
    return;
  }
  const newPassword = String(req.body.password || '').trim();
  if (newPassword.length < 4) {
    res.status(400).json({ error: 'Password needs to be at least 4 characters.' });
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  account.salt = salt;
  account.hash = hashPassword(newPassword, salt);
  saveAccounts();
  res.json({ ok: true });
});

// Post a message into the chat as "Admin" — shows up like a normal message
// from everyone else's point of view, just under that name.
app.post('/admin/api/message', requireAdmin, (req, res) => {
  const clean = String(req.body.text || '').trim().slice(0, 2000);
  if (!clean) {
    res.status(400).json({ error: 'Message text is required.' });
    return;
  }
  const payload = {
    id: crypto.randomBytes(8).toString('hex'),
    name: 'Admin',
    text: censor(clean),
    ts: Date.now(),
    admin: true
  };
  history.push(payload);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  saveHistory();
  io.emit('message', payload);
  res.json({ ok: true });
});

// Post an announcement — rendered as a prominent banner in the chat rather
// than a normal bubble, and stays in history so late joiners see it too.
app.post('/admin/api/announcement', requireAdmin, (req, res) => {
  const clean = String(req.body.text || '').trim().slice(0, 500);
  if (!clean) {
    res.status(400).json({ error: 'Announcement text is required.' });
    return;
  }
  const payload = {
    id: crypto.randomBytes(8).toString('hex'),
    name: 'Announcement',
    text: censor(clean),
    ts: Date.now(),
    announcement: true
  };
  history.push(payload);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  saveHistory();
  io.emit('message', payload);
  res.json({ ok: true });
});

server.listen(PORT, () => {
  console.log(`Chat server running on port ${PORT}`);
});

// ---- Keep-alive self-ping (optional) ----
// Render's free tier spins a service down after ~15 minutes with no
// incoming traffic. Pinging ourselves just under that window keeps it
// awake. This is an unofficial workaround, not something Render
// guarantees will always work — but it's widely used and generally
// reliable. Only runs if APP_URL is set (your own live URL), so it's a
// no-op for local development.
const APP_URL = process.env.APP_URL || '';
if (APP_URL) {
  const PING_INTERVAL_MS = 14 * 60 * 1000; // just under Render's 15-minute idle threshold
  setInterval(() => {
    https.get(APP_URL, res => {
      console.log(`Self-ping: ${res.statusCode}`);
      res.resume(); // drain the response so the socket can close cleanly
    }).on('error', err => {
      console.error(`Self-ping failed: ${err.message}`);
    });
  }, PING_INTERVAL_MS);
  console.log(`Self-ping enabled, pinging ${APP_URL} every ${PING_INTERVAL_MS / 60000} minutes.`);
} else {
  console.log('Self-ping disabled (no APP_URL set).');
}
