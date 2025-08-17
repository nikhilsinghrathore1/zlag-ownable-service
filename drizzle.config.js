import "dotenv/config";

export default {
  schema: './server.js',
  out: './drizzle/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: "postgresql://neondb_owner:npg_ay6ASxWjJ4wh@ep-billowing-surf-aex69pyy-pooler.c-2.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
  },
};