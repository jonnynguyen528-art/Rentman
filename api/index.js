// Vercel serverless entry point. Vercel auto-detects any file under /api as a
// function; this just hands our existing Express app to it. vercel.json rewrites
// every path (/mcp, /health) to this function so Express can do its own routing
// inside a single serverless function.
import app from "../app.js";

export default app;
