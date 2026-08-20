'use strict';

/*
 * Reset a login password from the command line.
 *
 *   npm run reset-password -- <new-password> [username]
 *   docker exec -it camera-recordings node src/tools/reset-password.js <new-password>
 *
 * Creates the user if it does not exist yet.
 */

const bcrypt = require('bcryptjs');
const { config } = require('../config');
const db = require('../db/index');

const password = process.argv[2];
const username = process.argv[3] || config.admin.username;

if (!password || password.length < 4) {
  console.error('Usage: node src/tools/reset-password.js <new-password> [username]');
  process.exit(1);
}

db.init();
const handle = db.getDb();
const hash = bcrypt.hashSync(password, 10);
const existing = handle.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  handle
    .prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?")
    .run(hash, existing.id);
  console.log(`Password updated for "${username}".`);
} else {
  handle.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(username, hash);
  console.log(`User "${username}" created.`);
}

db.setSetting('default_admin_password', '0');
console.log(`Database: ${config.dbFile}`);
process.exit(0);
