import { Request, Response, NextFunction } from "express";
import { verifyToken, createClerkClient } from "@clerk/backend";

const clerk = createClerkClient({
  secretKey: process.env.CLERK_SECRET_KEY!,
});

export interface AuthenticatedRequest extends Request {
  userId?: string;
  orgId?: string;
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing authorization header" });
    }

    const token = authHeader.split(" ")[1];
    
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY!,
    });

    req.userId = payload.sub;
    req.orgId = payload.org_id;
    
    next();
  } catch (error) {
    console.error("Auth error:", error);
    return res.status(401).json({ error: "Invalid token" });
  }
}

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

export { clerk };
