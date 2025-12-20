const admin = require("./firebase");
const { pool } = require("./db");

// 🔔 LOGIN NOTIFICATION (ADMIN ONLY)
async function notifyAdminLogin(fullname) {
  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE role = 'Admin'"
  );

  if (!admins.rows.length) return;

  const adminIds = admins.rows.map(r => r.userid);

  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [adminIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body: `User login\nUser: ${fullname}`
    },
    tokens
  });
}

// 🔔 SALES NOTIFICATION (ADMIN ONLY)
async function notifyAdminSale({
  createdByName,
  customerName,
  location,
  salesId
}) {
  const admins = await pool.query(
    "SELECT userid FROM tblusers WHERE role = 'Admin'"
  );
  if (!admins.rows.length) return;

  const adminIds = admins.rows.map(r => r.userid);

  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [adminIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

const pcsResult = await pool.query(
  `
  SELECT COALESCE(SUM(quantity), 0) AS total_pcs
  FROM tblsalesdetails
  WHERE salesid = $1
  `,
  [salesId]
);

const totalPcs = pcsResult.rows[0].total_pcs;


  const totalPcs = pcsResult.rows[0].total_pcs;

  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body:
        `Sale created\n` +
        `By: ${createdByName}\n` +
        `Customer: ${customerName}\n` +
        `Location: ${location}\n` +
        `Total PCS: ${totalPcs}`
    },
    tokens
  });
}
// 🔔 INCOMING NOTIFICATION (ADMIN + USER)
async function notifyIncoming({
  createdByName,
  location,
  incomingHeaderId
}) {
  // 1️⃣ Admin + User roles
  const users = await pool.query(
    "SELECT userid FROM tblusers WHERE role IN ('Admin','User')"
  );
  if (!users.rows.length) return;

  const userIds = users.rows.map(r => r.userid);

  // 2️⃣ Tokens
  const tokensResult = await pool.query(
    "SELECT token FROM tblfcm_tokens WHERE user_id = ANY($1)",
    [userIds]
  );

  const tokens = tokensResult.rows.map(r => r.token).filter(Boolean);
  if (!tokens.length) return;

  // 3️⃣ Total PCS
  const pcsResult = await pool.query(
    `
    SELECT COALESCE(SUM(quantity),0) AS total_pcs
    FROM tblincomingdetails
    WHERE incomingheaderid = $1
    `,
    [incomingHeaderId]
  );

  const totalPcs = pcsResult.rows[0].total_pcs;

  // 4️⃣ Send notification
  await admin.messaging().sendEachForMulticast({
    notification: {
      title: "Karni Fashions",
      body:
        `Incoming created\n` +
        `By: ${createdByName}\n` +
        `Location: ${location}\n` +
        `Total PCS: ${totalPcs}`
    },
    tokens
  });
}

// ✅ SINGLE, CLEAN EXPORT
module.exports = {
  notifyAdminLogin,
  notifyAdminSale,
  notifyIncoming
};
