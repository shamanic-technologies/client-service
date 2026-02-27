import { Request, Response, NextFunction } from "express";

export function requireApiKey(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const apiKey = req.headers["x-api-key"];
  const expectedKey = process.env.CLIENT_SERVICE_API_KEY;

  if (!expectedKey) {
    console.error("CLIENT_SERVICE_API_KEY not configured");
    return res.status(500).json({ error: "Server misconfiguration" });
  }

  if (apiKey !== expectedKey) {
    return res.status(401).json({ error: "Invalid API key" });
  }

  next();
}
