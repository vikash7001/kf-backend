import axios from "axios";

let accessToken = null;
let tokenExpiry = null;

export async function getFlipkartAccessToken() {
  const now = Date.now();

  if (accessToken && tokenExpiry && now < tokenExpiry) {
    return accessToken;
  }

  const params = new URLSearchParams();
  params.append("grant_type", "client_credentials");
  params.append("client_id", process.env.FLIPKART_CLIENT_ID);
  params.append("client_secret", process.env.FLIPKART_CLIENT_SECRET);

  const res = await axios.post(
    "https://api.flipkart.net/oauth-service/oauth/token",
    params,
    { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
  );

  accessToken = res.data.access_token;
  tokenExpiry = now + res.data.expires_in * 1000 - 60000; // refresh 1 min early

  console.log("Flipkart access token refreshed");

  return accessToken;
}
