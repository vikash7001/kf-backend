// activityLogger.js
const { pool } = require('./db');

async function logActivity({
  userId,
  username,
  actionType,
  description
}) {
  try {
    await pool.query(
      `
      INSERT INTO tblactivitylog
        (user_id, username, actiontype, description, actiontime)
      VALUES
        ($1, $2, $3, $4, NOW())
      `,
      [userId, username, actionType, description]
    );
  } catch (err) {
    console.error('❌ Activity log failed:', err);
  }
}

module.exports = { logActivity };
