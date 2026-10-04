const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs");
const bcrypt = require("bcrypt");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC = path.join(ROOT, "public");
const DB_FILE = path.join(ROOT, "social.db");
const SESSION_DAYS = 30;

fs.mkdirSync(PUBLIC, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true
  }
});

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.use(express.static(PUBLIC));

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

function nowIso() {
  return new Date().toISOString();
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createToken() {
  return crypto.randomBytes(32).toString("hex");
}

function sessionExpiry() {
  return new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

function safeUser(row) {
  if (!row) return null;

  return {
    id: row.id,
    username: row.username,
    email: row.email,
    phone: row.phone,
    role: row.role,
    account_type: row.account_type,
    is_verified: Boolean(row.is_verified),
    verified_at: row.verified_at,
    is_active: Boolean(row.is_active),
    display_name: row.display_name || row.username,
    bio: row.bio || "",
    avatar_path: row.avatar_path || null,
    cover_path: row.cover_path || null,
    website: row.website || null,
    location: row.location || null,
    is_private: Boolean(row.is_private),
    last_seen_at: row.last_seen_at || null,
    created_at: row.created_at
  };
}

function getUserById(id) {
  return db.prepare(`
    SELECT
      u.*,
      p.display_name,
      p.bio,
      p.avatar_path,
      p.cover_path,
      p.website,
      p.location,
      p.is_private,
      p.last_seen_at
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.id = ?
  `).get(id);
}

function getUserByUsername(username) {
  return db.prepare(`
    SELECT
      u.*,
      p.display_name,
      p.bio,
      p.avatar_path,
      p.cover_path,
      p.website,
      p.location,
      p.is_private,
      p.last_seen_at
    FROM users u
    LEFT JOIN profiles p ON p.user_id = u.id
    WHERE lower(u.username) = lower(?)
  `).get(username);
}

function authUser(req, res, next) {
  const header = req.get("Authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match) {
    return res.status(401).json({
      ok: false,
      error: "AUTH_REQUIRED"
    });
  }

  const tokenHash = hashToken(match[1]);

  const session = db.prepare(`
    SELECT user_id
    FROM sessions
    WHERE token_hash = ?
      AND expires_at > ?
  `).get(tokenHash, nowIso());

  if (!session) {
    return res.status(401).json({
      ok: false,
      error: "INVALID_SESSION"
    });
  }

  const user = getUserById(session.user_id);

  if (!user || !user.is_active) {
    return res.status(403).json({
      ok: false,
      error: "ACCOUNT_DISABLED"
    });
  }

  db.prepare(`
    UPDATE sessions
    SET last_used_at = ?
    WHERE token_hash = ?
  `).run(nowIso(), tokenHash);

  req.user = user;
  req.sessionTokenHash = tokenHash;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({
      ok: false,
      error: "ADMIN_REQUIRED"
    });
  }

  next();
}

function createNotification(userId, actorId, type, entityType, entityId, data = {}) {
  if (!userId) return;

  db.prepare(`
    INSERT INTO notifications
      (user_id, actor_id, type, entity_type, entity_id, data_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    actorId || null,
    type,
    entityType || null,
    entityId != null ? String(entityId) : null,
    JSON.stringify(data)
  );

  io.to(`user:${userId}`).emit("notification:new", {
    type,
    entity_type: entityType || null,
    entity_id: entityId != null ? String(entityId) : null,
    data
  });
}

const createUser = db.transaction((input) => {
  const username = String(input.username || "").trim().toLowerCase();
  const password = String(input.password || "");
  const email = input.email ? String(input.email).trim().toLowerCase() : null;
  const phone = input.phone ? String(input.phone).trim() : null;
  const displayName = String(input.display_name || username).trim();

  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    throw new Error("INVALID_USERNAME");
  }

  if (password.length < 6) {
    throw new Error("PASSWORD_TOO_SHORT");
  }

  if (!displayName || displayName.length > 80) {
    throw new Error("INVALID_DISPLAY_NAME");
  }

  if (getUserByUsername(username)) {
    throw new Error("USERNAME_TAKEN");
  }

  if (email) {
    const exists = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?)").get(email);
    if (exists) throw new Error("EMAIL_TAKEN");
  }

  if (phone) {
    const exists = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
    if (exists) throw new Error("PHONE_TAKEN");
  }

  const passwordHash = bcrypt.hashSync(password, 12);

  const result = db.prepare(`
    INSERT INTO users
      (username, email, phone, password_hash)
    VALUES (?, ?, ?, ?)
  `).run(username, email, phone, passwordHash);

  const userId = Number(result.lastInsertRowid);

  db.prepare(`
    INSERT INTO profiles
      (user_id, display_name)
    VALUES (?, ?)
  `).run(userId, displayName);

  db.prepare(`
    INSERT INTO wallets (user_id)
    VALUES (?)
  `).run(userId);

  return getUserById(userId);
});

function loginUser(user) {
  const token = createToken();
  const tokenHash = hashToken(token);

  db.prepare(`
    INSERT INTO sessions
      (user_id, token_hash, expires_at, last_used_at)
    VALUES (?, ?, ?, ?)
  `).run(
    user.id,
    tokenHash,
    sessionExpiry(),
    nowIso()
  );

  return token;
}

app.get("/health", (_req, res) => {
  let database = false;

  try {
    db.prepare("SELECT 1").get();
    database = true;
  } catch {}

  res.json({
    ok: true,
    service: "alivizo-social",
    database,
    databaseType: "sqlite",
    realtime: true,
    time: nowIso()
  });
});

app.get("/api", (_req, res) => {
  res.json({
    ok: true,
    name: "Alivizo Social",
    version: "1.0.0",
    features: [
      "accounts",
      "profiles",
      "posts",
      "follows",
      "chat",
      "voice-video-calls",
      "live-streaming",
      "notifications",
      "coins",
      "gifts",
      "earnings",
      "withdrawals",
      "verification",
      "moderation"
    ]
  });
});

app.post("/api/auth/register", (req, res) => {
  try {
    const user = createUser(req.body || {});
    const token = loginUser(user);

    res.status(201).json({
      ok: true,
      token,
      expires_at: sessionExpiry(),
      user: safeUser(user)
    });
  } catch (error) {
    const known = new Set([
      "INVALID_USERNAME",
      "PASSWORD_TOO_SHORT",
      "INVALID_DISPLAY_NAME",
      "USERNAME_TAKEN",
      "EMAIL_TAKEN",
      "PHONE_TAKEN"
    ]);

    const code = known.has(error.message)
      ? error.message
      : "REGISTER_FAILED";

    res.status(400).json({
      ok: false,
      error: code
    });
  }
});

app.post("/api/auth/login", (req, res) => {
  const identifier = String(req.body?.identifier || "").trim();
  const password = String(req.body?.password || "");

  if (!identifier || !password) {
    return res.status(400).json({
      ok: false,
      error: "IDENTIFIER_AND_PASSWORD_REQUIRED"
    });
  }

  const user = db.prepare(`
    SELECT *
    FROM users
    WHERE lower(username) = lower(?)
       OR lower(email) = lower(?)
       OR phone = ?
    LIMIT 1
  `).get(identifier, identifier, identifier);

  if (!user || !user.is_active || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({
      ok: false,
      error: "INVALID_CREDENTIALS"
    });
  }

  const token = loginUser(user);
  const fullUser = getUserById(user.id);

  res.json({
    ok: true,
    token,
    expires_at: sessionExpiry(),
    user: safeUser(fullUser)
  });
});

app.post("/api/auth/logout", authUser, (req, res) => {
  db.prepare(`
    DELETE FROM sessions
    WHERE token_hash = ?
  `).run(req.sessionTokenHash);

  res.json({ ok: true });
});

app.get("/api/me", authUser, (req, res) => {
  res.json({
    ok: true,
    user: safeUser(getUserById(req.user.id))
  });
});

app.get("/api/users/:username", (req, res) => {
  const user = getUserByUsername(req.params.username);

  if (!user || !user.is_active) {
    return res.status(404).json({
      ok: false,
      error: "USER_NOT_FOUND"
    });
  }

  res.json({
    ok: true,
    user: safeUser(user)
  });
});

app.post("/api/follow/:userId", authUser, (req, res) => {
  const targetId = Number(req.params.userId);

  if (!Number.isInteger(targetId) || targetId === req.user.id) {
    return res.status(400).json({
      ok: false,
      error: "INVALID_TARGET"
    });
  }

  const target = getUserById(targetId);

  if (!target || !target.is_active) {
    return res.status(404).json({
      ok: false,
      error: "USER_NOT_FOUND"
    });
  }

  const blocked = db.prepare(`
    SELECT 1
    FROM blocks
    WHERE (blocker_id = ? AND blocked_id = ?)
       OR (blocker_id = ? AND blocked_id = ?)
  `).get(req.user.id, targetId, targetId, req.user.id);

  if (blocked) {
    return res.status(403).json({
      ok: false,
      error: "USER_BLOCKED"
    });
  }

  const exists = db.prepare(`
    SELECT 1 FROM follows
    WHERE follower_id = ? AND following_id = ?
  `).get(req.user.id, targetId);

  if (exists) {
    db.prepare(`
      DELETE FROM follows
      WHERE follower_id = ? AND following_id = ?
    `).run(req.user.id, targetId);

    return res.json({
      ok: true,
      following: false
    });
  }

  db.prepare(`
    INSERT INTO follows (follower_id, following_id)
    VALUES (?, ?)
  `).run(req.user.id, targetId);

  createNotification(
    targetId,
    req.user.id,
    "follow",
    "user",
    req.user.id
  );

  res.json({
    ok: true,
    following: true
  });
});

app.get("/api/notifications", authUser, (req, res) => {
  const limit = Math.min(
    Math.max(Number(req.query.limit) || 30, 1),
    100
  );

  const rows = db.prepare(`
    SELECT
      n.*,
      u.username AS actor_username,
      p.display_name AS actor_display_name,
      p.avatar_path AS actor_avatar
    FROM notifications n
    LEFT JOIN users u ON u.id = n.actor_id
    LEFT JOIN profiles p ON p.user_id = n.actor_id
    WHERE n.user_id = ?
    ORDER BY n.id DESC
    LIMIT ?
  `).all(req.user.id, limit);

  res.json({
    ok: true,
    notifications: rows
  });
});

app.post("/api/notifications/read", authUser, (req, res) => {
  db.prepare(`
    UPDATE notifications
    SET is_read = 1
    WHERE user_id = ?
  `).run(req.user.id);

  res.json({ ok: true });
});

app.get("/api/wallet", authUser, (req, res) => {
  let wallet = db.prepare(`
    SELECT *
    FROM wallets
    WHERE user_id = ?
  `).get(req.user.id);

  if (!wallet) {
    db.prepare(`
      INSERT INTO wallets (user_id)
      VALUES (?)
    `).run(req.user.id);

    wallet = db.prepare(`
      SELECT *
      FROM wallets
      WHERE user_id = ?
    `).get(req.user.id);
  }

  res.json({
    ok: true,
    wallet
  });
});

app.get("/api/gifts", (_req, res) => {
  const gifts = db.prepare(`
    SELECT *
    FROM gifts
    WHERE is_active = 1
    ORDER BY coins_cost ASC
  `).all();

  res.json({
    ok: true,
    gifts
  });
});

app.get("/api/admin/stats", authUser, requireAdmin, (_req, res) => {
  const stats = {
    users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
    posts: db.prepare("SELECT COUNT(*) AS count FROM posts WHERE is_deleted = 0").get().count,
    messages: db.prepare("SELECT COUNT(*) AS count FROM messages WHERE is_deleted = 0").get().count,
    live_streams: db.prepare("SELECT COUNT(*) AS count FROM live_streams").get().count,
    pending_verifications: db.prepare(`
      SELECT COUNT(*) AS count
      FROM verification_requests
      WHERE status = 'pending'
    `).get().count,
    pending_withdrawals: db.prepare(`
      SELECT COUNT(*) AS count
      FROM withdrawal_requests
      WHERE status IN ('pending','reviewing')
    `).get().count,
    pending_reports: db.prepare(`
      SELECT COUNT(*) AS count
      FROM reports
      WHERE status IN ('pending','reviewing')
    `).get().count
  };

  res.json({
    ok: true,
    stats
  });
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;

    if (!token) {
      return next(new Error("AUTH_REQUIRED"));
    }

    const session = db.prepare(`
      SELECT user_id
      FROM sessions
      WHERE token_hash = ?
        AND expires_at > ?
    `).get(hashToken(token), nowIso());

    if (!session) {
      return next(new Error("INVALID_SESSION"));
    }

    const user = getUserById(session.user_id);

    if (!user || !user.is_active) {
      return next(new Error("ACCOUNT_DISABLED"));
    }

    socket.user = user;
    next();
  } catch {
    next(new Error("AUTH_FAILED"));
  }
});

io.on("connection", (socket) => {
  const userId = socket.user.id;

  socket.join(`user:${userId}`);

  db.prepare(`
    UPDATE profiles
    SET last_seen_at = ?
    WHERE user_id = ?
  `).run(nowIso(), userId);

  socket.broadcast.emit("presence:update", {
    user_id: userId,
    online: true
  });

  socket.on("conversation:join", (conversationId) => {
    const id = Number(conversationId);

    const member = db.prepare(`
      SELECT 1
      FROM conversation_members
      WHERE conversation_id = ?
        AND user_id = ?
    `).get(id, userId);

    if (member) {
      socket.join(`conversation:${id}`);
    }
  });

  socket.on("typing:start", (conversationId) => {
    socket.to(`conversation:${Number(conversationId)}`).emit("typing:start", {
      conversation_id: Number(conversationId),
      user_id: userId
    });
  });

  socket.on("typing:stop", (conversationId) => {
    socket.to(`conversation:${Number(conversationId)}`).emit("typing:stop", {
      conversation_id: Number(conversationId),
      user_id: userId
    });
  });

  socket.on("call:offer", (payload) => {
    if (!payload?.target_user_id) return;

    io.to(`user:${Number(payload.target_user_id)}`).emit("call:offer", {
      ...payload,
      caller_user_id: userId
    });
  });

  socket.on("call:answer", (payload) => {
    if (!payload?.target_user_id) return;

    io.to(`user:${Number(payload.target_user_id)}`).emit("call:answer", {
      ...payload,
      user_id: userId
    });
  });

  socket.on("call:ice", (payload) => {
    if (!payload?.target_user_id) return;

    io.to(`user:${Number(payload.target_user_id)}`).emit("call:ice", {
      ...payload,
      user_id: userId
    });
  });

  socket.on("call:end", (payload) => {
    if (!payload?.target_user_id) return;

    io.to(`user:${Number(payload.target_user_id)}`).emit("call:end", {
      ...payload,
      user_id: userId
    });
  });

  socket.on("disconnect", () => {
    db.prepare(`
      UPDATE profiles
      SET last_seen_at = ?
      WHERE user_id = ?
    `).run(nowIso(), userId);

    socket.broadcast.emit("presence:update", {
      user_id: userId,
      online: false,
      last_seen_at: nowIso()
    });
  });
});

app.get("*splat", (_req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Alivizo Social running on port ${PORT}`);
});
