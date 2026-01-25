const axios = require("axios");

let accessToken = null;
let tokenExpiry = null;

async function getFlipkartAccessToken() {
  const now = Date.now();

  if (accessToken && tokenExpiry && now < tokenExpiry) {
    return accessToken;
  }

  const auth = Buffer.from(
    `${process.env.FLIPKART_CLIENT_ID}:${process.env.FLIPKART_CLIENT_SECRET}`
  ).toString("base64");

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");

  const res = await axios.post(
    "https://api.flipkart.net/oauth-service/oauth/token",
    params,
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Authorization": `Basic ${auth}`
      }
    }
  );

  accessToken = res.data.access_token;
  tokenExpiry = now + res.data.expires_in * 1000 - 60_000;

  console.log("✅ Flipkart access token refreshed");
  return accessToken;
}

module.exports = { getFlipkartAccessToken };
