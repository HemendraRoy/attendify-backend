import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import authRoutes from './routes/auth.js';
import classRoutes from './routes/classes.js';
import attendanceRoutes from './routes/attendance.js';

const app = express();
const port = Number(process.env.PORT ?? 10000);

app.use(cors({ origin: process.env.CORS_ORIGIN === '*' || !process.env.CORS_ORIGIN ? true : process.env.CORS_ORIGIN.split(',').map((v) => v.trim()) }));
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'attendify-api' }));
app.use('/auth', authRoutes);
app.use('/classes', classRoutes);
app.use('/attendance', attendanceRoutes);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err && typeof err === 'object' && 'issues' in err) {
    return res.status(400).json({ message: 'Validation error', details: (err as { issues: unknown }).issues });
  }
  console.error(err);
  return res.status(500).json({ message: 'Internal server error' });
});

app.listen(port, '0.0.0.0', () => {
  console.log(`Attendify API listening on port ${port}`);
});
