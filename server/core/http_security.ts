import express, { type RequestHandler } from 'express';

export const secureResponseHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
};

const smallJson = express.json({ inflate: false });
export const imageJson = express.json({ limit: '12mb', inflate: false });
export const authenticatedJson: RequestHandler = (req, res, next) =>
  req.path.toLowerCase() === '/api/see' ? next() : smallJson(req, res, next);
