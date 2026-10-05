require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "aurora.db");

if (!BOT_TOKEN) {
  console.warn("WARNING: BOT_TOKEN is not set. Telegram initData authentication will fail.");
}

require("fs").mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id TEXT NOT NULL UNIQUE,
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  tasks_completed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  reward INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS task_completions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  completed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, task_id),
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inviter_user_id INTEGER NOT NULL,
  invited_user_id INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(inviter_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(invited_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS rewards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  amount INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);
`);

const taskCount = db.prepare("SELECT COUNT(*) AS c FROM tasks").get().c;
if (taskCount === 0) {
  const insert = db.prepare(
    "INSERT INTO tasks (title, description, reward) VALUES (?, ?, ?)"
  );
  const seed = db.transaction(() => {
    insert.run("ورود روزانه", "اولین ورود شما به AURORA", 10);
    insert.run("معرفی AURORA", "بررسی صفحه اصلی Mini App", 20);
    insert.run("تسک اول", "اولین تسک واقعی AURORA را انجام دهید", 50);
  });
  seed();
}

app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

function validateTelegramInitData(initData) {
  if (!BOT_TOKEN || !initData || typeof initData !== "string") return null;

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate)) return null;

  // Reject stale login data (24 hours).
  if (Math.abs(Math.floor(Date.now() / 1000) - authDate) > 86400) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();

  const calculatedHash = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  if (!crypto.timingSafeEqual(
    Buffer.from(calculatedHash, "utf8"),
    Buffer.from(hash, "utf8")
  )) return null;

  let user;
  try {
    user = JSON.parse(params.get("user") || "{}");
  } catch {
    return null;
  }

  if (!user.id) return null;
  return user;
}

function upsertUser(tgUser) {
  const telegramId = String(tgUser.id);

  db.prepare(`
    INSERT INTO users (telegram_id, username, first_name, last_name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(telegram_id) DO UPDATE SET
      username=excluded.username,
      first_name=excluded.first_name,
      last_name=excluded.last_name,
      updated_at=CURRENT_TIMESTAMP
  `).run(
    telegramId,
    tgUser.username || null,
    tgUser.first_name || null,
    tgUser.last_name || null
  );

  return db.prepare("SELECT * FROM users WHERE telegram_id = ?").get(telegramId);
}

function auth(req, res, next) {
  const initData = req.get("X-Telegram-Init-Data");
  const tgUser = validateTelegramInitData(initData);

  if (!tgUser) {
    return res.status(401).json({
      ok: false,
      error: "UNAUTHORIZED",
      message: "Telegram authentication failed."
    });
  }

  req.tgUser = tgUser;
  req.user = upsertUser(tgUser);
  next();
}

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "AURORA", database: "connected" });
});

app.get("/api/me", auth, (req, res) => {
  const referrals = db.prepare(
    "SELECT COUNT(*) AS c FROM referrals WHERE inviter_user_id = ?"
  ).get(req.user.id).c;

  res.json({
    ok: true,
    user: {
      telegramId: req.user.telegram_id,
      username: req.user.username,
      firstName: req.user.first_name,
      lastName: req.user.last_name,
      points: req.user.points,
      tasksCompleted: req.user.tasks_completed,
      referrals
    }
  });
});

app.get("/api/tasks", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      t.id, t.title, t.description, t.reward,
      CASE WHEN tc.id IS NULL THEN 0 ELSE 1 END AS completed
    FROM tasks t
    LEFT JOIN task_completions tc
      ON tc.task_id = t.id AND tc.user_id = ?
    WHERE t.active = 1
    ORDER BY t.id ASC
  `).all(req.user.id);

  res.json({ ok: true, tasks: rows.map(t => ({ ...t, completed: Boolean(t.completed) })) });
});

app.post("/api/tasks/:id/complete", auth, (req, res) => {
  const taskId = Number(req.params.id);
  if (!Number.isInteger(taskId)) {
    return res.status(400).json({ ok: false, error: "INVALID_TASK" });
  }

  const task = db.prepare(
    "SELECT * FROM tasks WHERE id = ? AND active = 1"
  ).get(taskId);

  if (!task) {
    return res.status(404).json({ ok: false, error: "TASK_NOT_FOUND" });
  }

  const already = db.prepare(
    "SELECT id FROM task_completions WHERE user_id = ? AND task_id = ?"
  ).get(req.user.id, taskId);

  if (already) {
    return res.status(409).json({ ok: false, error: "TASK_ALREADY_COMPLETED" });
  }

  const complete = db.transaction(() => {
    db.prepare(
      "INSERT INTO task_completions (user_id, task_id) VALUES (?, ?)"
    ).run(req.user.id, taskId);

    db.prepare(`
      UPDATE users
      SET points = points + ?, tasks_completed = tasks_completed + 1, updated_at=CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(task.reward, req.user.id);

    db.prepare(
      "INSERT INTO rewards (user_id, type, amount, note) VALUES (?, ?, ?, ?)"
    ).run(req.user.id, "task", task.reward, `Task #${task.id}`);
  });

  complete();

  const user = db.prepare(
    "SELECT points, tasks_completed FROM users WHERE id = ?"
  ).get(req.user.id);

  res.json({ ok: true, reward: task.reward, user });
});

app.get("/api/leaderboard", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT
      ROW_NUMBER() OVER (ORDER BY points DESC, id ASC) AS rank,
      first_name AS firstName,
      username,
      points,
      tasks_completed AS tasksCompleted
    FROM users
    ORDER BY points DESC, id ASC
    LIMIT 50
  `).all();

  res.json({ ok: true, leaderboard: rows });
});

app.get("/api/referral", auth, (req, res) => {
  const botUsername = process.env.BOT_USERNAME || "YOUR_BOT_USERNAME";
  const link = `https://t.me/${botUsername}?start=ref_${req.user.telegram_id}`;

  const count = db.prepare(
    "SELECT COUNT(*) AS c FROM referrals WHERE inviter_user_id = ?"
  ).get(req.user.id).c;

  res.json({ ok: true, link, referrals: count });
});

// Called by the Mini App when it receives a start parameter such as ref_12345.
// Referral reward is granted once to the inviter.
app.post("/api/referral/claim", auth, (req, res) => {
  const startParam = String(req.body?.startParam || "");
  const match = /^ref_(\d+)$/.exec(startParam);
  if (!match) return res.status(400).json({ ok: false, error: "INVALID_REFERRAL" });

  const inviter = db.prepare(
    "SELECT * FROM users WHERE telegram_id = ?"
  ).get(match[1]);

  if (!inviter || inviter.id === req.user.id) {
    return res.status(400).json({ ok: false, error: "INVALID_INVITER" });
  }

  const exists = db.prepare(
    "SELECT id FROM referrals WHERE invited_user_id = ?"
  ).get(req.user.id);

  if (exists) return res.status(409).json({ ok: false, error: "REFERRAL_ALREADY_CLAIMED" });

  const REWARD = 100;

  const claim = db.transaction(() => {
    db.prepare(
      "INSERT INTO referrals (inviter_user_id, invited_user_id) VALUES (?, ?)"
    ).run(inviter.id, req.user.id);

    db.prepare(
      "UPDATE users SET points = points + ?, updated_at=CURRENT_TIMESTAMP WHERE id = ?"
    ).run(REWARD, inviter.id);

    db.prepare(
      "INSERT INTO rewards (user_id, type, amount, note) VALUES (?, ?, ?, ?)"
    ).run(inviter.id, "referral", REWARD, `Referral of Telegram user ${req.user.telegram_id}`);
  });

  claim();

  res.json({ ok: true, reward: REWARD });
});
// ===============================
// Telegram Bot - /start
// ===============================

async function telegramRequest(method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    }
  );

  return response.json();
}

let telegramOffset = 0;

async function startTelegramBot() {
  if (!BOT_TOKEN) {
    console.log("BOT_TOKEN is not set. Telegram bot is disabled.");
    return;
  }

  console.log("AURORA Telegram bot started.");

  while (true) {
    try {
      const result = await telegramRequest("getUpdates", {
        offset: telegramOffset,
        timeout: 30,
        allowed_updates: ["message"]
      });

      if (!result.ok) {
        console.error("Telegram getUpdates error:", result.description);
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      for (const update of result.result) {
        telegramOffset = update.update_id + 1;

        const message = update.message;

        if (!message || !message.text) {
          continue;
        }

        if (message.text.startsWith("/start")) {
          await telegramRequest("sendMessage", {
            chat_id: message.chat.id,
            text: "به AURORA خوش اومدی 🚀",
            reply_markup: {
              inline_keyboard: [
                [
    text: "🚀 ورود به AURORA",
    web_app: {
        url: https://aurora-mini-app-1.onrender.com
    }
                  }
                  }
                ]
              ]
            }
          });

          console.log(
            `AURORA /start received from Telegram user ${message.from?.id}`
          );
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

startTelegramBot();
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`AURORA server running on port ${PORT}`);
});
