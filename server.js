// Entry point for "always-on" hosts (local dev, Render, Fly.io, a VPS, etc).
// Vercel does NOT use this file — see api/index.js for that.
import app from "./app.js";

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Rentman MCP server listening on port ${PORT}`);
});
