import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pkg from 'pg';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const { Pool } = pkg;

// Neon DB configuration with SSL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false // Required for Neon DB
  },
  // Optional: Connection pool settings for better performance
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 10000, // Return an error after 10 seconds if connection could not be established
});

const db = drizzle(pool);

async function setupDatabase() {
  try {
    console.log('🔄 Setting up database...');
    console.log('📡 Connecting to Neon DB...');
    
    // Test connection first
    const client = await pool.connect();
    console.log('✅ Connected to Neon database successfully!');
    
    // Get database info
    const result = await client.query('SELECT version()');
    console.log('📊 Database version:', result.rows[0].version.split(' ')[0]);
    client.release();
    
    // Run migrations
    console.log('🚀 Running database migrations...');
    await migrate(db, { 
      migrationsFolder: './drizzle/migrations'
    });
    
    console.log('✅ Database setup complete!');
    console.log('🎉 All migrations applied successfully!');
    
  } catch (error) {
    console.error('❌ Database setup failed:', error);
    
    // More detailed error information
    if (error.code === 'ECONNREFUSED') {
      console.error('🔗 Connection refused. Please check:');
      console.error('   - Your DATABASE_URL environment variable');
      console.error('   - Your internet connection');
      console.error('   - Neon database status');
    } else if (error.code === 'ENOTFOUND') {
      console.error('🌐 DNS resolution failed. Please check your DATABASE_URL');
    } else if (error.message?.includes('password')) {
      console.error('🔑 Authentication failed. Please check your credentials');
    } else if (error.message?.includes('SSL')) {
      console.error('🔒 SSL connection issue. Neon requires SSL connections');
    }
    
    process.exit(1);
  } finally {
    // Always close the pool
    try {
      await pool.end();
      console.log('🔌 Database connection closed');
    } catch (closeError) {
      console.error('Error closing database connection:', closeError);
    }
    process.exit(0);
  }
}

// Handle process termination gracefully
process.on('SIGINT', async () => {
  console.log('\n🛑 Received SIGINT, closing database connection...');
  try {
    await pool.end();
    console.log('🔌 Database connection closed gracefully');
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Received SIGTERM, closing database connection...');
  try {
    await pool.end();
    console.log('🔌 Database connection closed gracefully');
  } catch (error) {
    console.error('Error during graceful shutdown:', error);
  }
  process.exit(0);
});

setupDatabase();