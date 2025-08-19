import express from 'express';
import cors from 'cors';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text, timestamp, jsonb, integer, boolean, decimal } from 'drizzle-orm/pg-core';
import { relations, eq, and } from 'drizzle-orm';
import { z } from 'zod';
import pkg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const { Pool } = pkg;

// Initialize Express
const app = express();
app.use(express.json());
app.use(cors());

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://username:password@localhost:5432/agents_db',
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

const db = drizzle(pool);

// Database Schema
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  walletAddress: text('wallet_address').unique().notNull(),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const agents = pgTable('agents', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  model: text('model').notNull(),
  capabilities: jsonb('capabilities').notNull(),
  price: decimal('price', { precision: 10, scale: 2 }).notNull().default('0'),
  isForSale: boolean('is_for_sale').default(false).notNull(),
  creatorId: integer('creator_id').references(() => users.id).notNull(),
  // Smart contract agent ID
  agentId: integer('agent_id').unique(), // Can be null for agents created without smart contract
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const agentOwnerships = pgTable('agent_ownerships', {
  id: serial('id').primaryKey(),
  agentId: integer('agent_id').references(() => agents.agentId).notNull(),
  userId: integer('user_id').references(() => users.id).notNull(),
  purchasedAt: timestamp('purchased_at').defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  createdAgents: many(agents),
  ownedAgents: many(agentOwnerships),
}));

export const agentsRelations = relations(agents, ({ one, many }) => ({
  creator: one(users, {
    fields: [agents.creatorId],
    references: [users.id],
  }),
  ownerships: many(agentOwnerships),
}));

export const agentOwnershipRelations = relations(agentOwnerships, ({ one }) => ({
  agent: one(agents, {
    fields: [agentOwnerships.agentId],
    references: [agents.id],
  }),
  user: one(users, {
    fields: [agentOwnerships.userId],
    references: [users.id],
  }),
}));

// Validation schemas
const walletAddressSchema = z.string().min(42).max(42).regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid wallet address');

const createUserSchema = z.object({
  walletAddress: walletAddressSchema,
});

const createAgentSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().min(1).max(1000),
  model: z.string().min(1).max(100),
  capabilities: z.array(z.string()).min(1),
  price: z.number().min(0).optional(),
  isForSale: z.boolean().optional(),
  creatorWalletAddress: walletAddressSchema,
  // Smart contract agent ID
  agentId: z.number().positive().optional(),
});

const buyAgentSchema = z.object({
  agentId: z.number().positive(),
  buyerWalletAddress: walletAddressSchema,
});

// Helper function to get or create user
async function getOrCreateUser(walletAddress) {
  try {
    let user = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    if (user.length === 0) {
      const newUser = await db.insert(users).values({ walletAddress }).returning();
      return newUser[0];
    }

    return user[0];
  } catch (error) {
    throw new Error(`Database error: ${error.message}`);
  }
}

// Health check route
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'Agents API is running',
    timestamp: new Date().toISOString()
  });
});

app.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API is healthy',
    timestamp: new Date().toISOString()
  });
});

// Routes

// 1. Create User
app.post('/api/users', async (req, res) => {
  try {
    const { walletAddress } = createUserSchema.parse(req.body);

    const existingUser = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    if (existingUser.length > 0) {
      return res.status(400).json({ error: 'User with this wallet address already exists' });
    }

    const newUser = await db.insert(users).values({ walletAddress }).returning();

    res.status(201).json({
      success: true,
      user: newUser[0]
    });
  } catch (error) {
    console.error('Create user error:', error);
    res.status(400).json({ error: error.message });
  }
});

// 9. Check if user exists by wallet address
app.get('/api/users/:walletAddress/exists', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    // Validate wallet address format
    if (!walletAddressSchema.safeParse(walletAddress).success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid wallet address format'
      });
    }

    // Check if user exists
    const user = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    const userExists = user.length > 0;

    res.json({
      success: true,
      exists: userExists,
      user: userExists ? {
        id: user[0].id,
        walletAddress: user[0].walletAddress,
        createdAt: user[0].createdAt,
        updatedAt: user[0].updatedAt
      } : null
    });

  } catch (error) {
    console.error('Check user exists error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// 2. Create Agent (FIXED)
app.post('/api/agents', async (req, res) => {
  try {
    const agentData = createAgentSchema.parse(req.body);

    const creator = await getOrCreateUser(agentData.creatorWalletAddress);

    // Check if agentId already exists (if provided)
    if (agentData.agentId) {
      const existingAgent = await db.select()
        .from(agents)
        .where(eq(agents.agentId, agentData.agentId))
        .limit(1);

      if (existingAgent.length > 0) {
        return res.status(400).json({
          error: `Agent with smart contract ID ${agentData.agentId} already exists`
        });
      }
    }

    const newAgent = await db.insert(agents).values({
      name: agentData.name,
      description: agentData.description,
      model: agentData.model,
      capabilities: agentData.capabilities,
      price: agentData.price || 0,
      isForSale: agentData.isForSale || false,
      creatorId: creator.id,
      agentId: agentData.agentId || null, // Smart contract agent ID
    }).returning();

    // Creator automatically owns their created agent
    await db.insert(agentOwnerships).values({
      agentId: agentData.agentId,
      userId: creator.id,
    });

    res.status(201).json({
      success: true,
      agent: newAgent[0]
    });
  } catch (error) {
    console.error('Create agent error:', error);
    res.status(400).json({ error: error.message });
  }
});

// 3. Get all agents created by a user
app.get('/api/users/:walletAddress/created-agents', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    if (!walletAddressSchema.safeParse(walletAddress).success) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    const user = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const createdAgents = await db.select().from(agents).where(eq(agents.creatorId, user[0].id));

    res.json({
      success: true,
      agents: createdAgents
    });
  } catch (error) {
    console.error('Get created agents error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Get all agents (marketplace)
app.get('/api/agents', async (req, res) => {
  try {
    const allAgents = await db.select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      model: agents.model,
      capabilities: agents.capabilities,
      price: agents.price,
      isForSale: agents.isForSale,
      creatorId: agents.creatorId,
      agentId: agents.agentId, // Smart contract agent ID
      createdAt: agents.createdAt,
      creator: {
        id: users.id,
        walletAddress: users.walletAddress,
      }
    }).from(agents)
      .leftJoin(users, eq(agents.creatorId, users.id));

    res.json({
      success: true,
      agents: allAgents
    });
  } catch (error) {
    console.error('Get all agents error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Get all agents a user owns
app.get('/api/users/:walletAddress/owned-agents', async (req, res) => {
  try {
    const { walletAddress } = req.params;

    if (!walletAddressSchema.safeParse(walletAddress).success) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    const user = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    if (user.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const ownedAgents = await db.select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      model: agents.model,
      capabilities: agents.capabilities,
      price: agents.price,
      isForSale: agents.isForSale,
      creatorId: agents.creatorId,
      agentId: agents.agentId, // Smart contract agent ID
      createdAt: agents.createdAt,
      purchasedAt: agentOwnerships.purchasedAt,
      creator: {
        id: users.id,
        walletAddress: users.walletAddress,
      }
    }).from(agentOwnerships)
      .innerJoin(agents, eq(agentOwnerships.agentId, agents.id))
      .leftJoin(users, eq(agents.creatorId, users.id))
      .where(eq(agentOwnerships.userId, user[0].id));

    res.json({
      success: true,
      agents: ownedAgents
    });
  } catch (error) {
    console.error('Get owned agents error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 6. Buy an agent
app.post('/api/agents/buy', async (req, res) => {
  try {
    const { agentId, buyerWalletAddress } = buyAgentSchema.parse(req.body);

    const buyer = await getOrCreateUser(buyerWalletAddress);

    // Check if agent exists and is for sale
    const agent = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);

    if (agent.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    if (!agent[0].isForSale) {
      return res.status(400).json({ error: 'Agent is not for sale' });
    }

    // Check if user already owns this agent
    const existingOwnership = await db.select()
      .from(agentOwnerships)
      .where(and(
        eq(agentOwnerships.agentId, agentId),
        eq(agentOwnerships.userId, buyer.id)
      )).limit(1);

    if (existingOwnership.length > 0) {
      return res.status(400).json({ error: 'You already own this agent' });
    }

    // Create ownership record
    const newOwnership = await db.insert(agentOwnerships).values({
      agentId: agentId,
      userId: buyer.id,
    }).returning();

    res.json({
      success: true,
      message: 'Agent purchased successfully',
      ownership: newOwnership[0],
      agent: agent[0]
    });
  } catch (error) {
    console.error('Buy agent error:', error);
    res.status(400).json({ error: error.message });
  }
});

// 7. Check if user owns an agent (for usage validation)
app.get('/api/agents/:agentId/ownership/:walletAddress', async (req, res) => {
  try {
    const { agentId, walletAddress } = req.params;

    if (!walletAddressSchema.safeParse(walletAddress).success) {
      return res.status(400).json({ error: 'Invalid wallet address format' });
    }

    const user = await db.select().from(users).where(eq(users.walletAddress, walletAddress)).limit(1);

    if (user.length === 0) {
      return res.json({ success: true, owns: false });
    }

    const ownership = await db.select()
      .from(agentOwnerships)
      .where(and(
        eq(agentOwnerships.agentId, parseInt(agentId)),
        eq(agentOwnerships.userId, user[0].id)
      )).limit(1);

    res.json({
      success: true,
      owns: ownership.length > 0,
      ownership: ownership.length > 0 ? ownership[0] : null
    });
  } catch (error) {
    console.error('Check ownership error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 8. Get single agent details
app.get('/api/agents/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    const agent = await db.select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      model: agents.model,
      capabilities: agents.capabilities,
      price: agents.price,
      isForSale: agents.isForSale,
      creatorId: agents.creatorId,
      agentId: agents.agentId, // Smart contract agent ID
      createdAt: agents.createdAt,
      creator: {
        id: users.id,
        walletAddress: users.walletAddress,
      }
    }).from(agents)
      .leftJoin(users, eq(agents.creatorId, users.id))
      .where(eq(agents.id, parseInt(agentId)))
      .limit(1);

    if (agent.length === 0) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      success: true,
      agent: agent[0]
    });
  } catch (error) {
    console.error('Get agent details error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get agent by smart contract ID
app.get('/api/agents/by-contract/:agentId', async (req, res) => {
  try {
    const { agentId } = req.params;

    const agent = await db.select({
      id: agents.id,
      name: agents.name,
      description: agents.description,
      model: agents.model,
      capabilities: agents.capabilities,
      price: agents.price,
      isForSale: agents.isForSale,
      creatorId: agents.creatorId,
      agentId: agents.agentId,
      createdAt: agents.createdAt,
      creator: {
        id: users.id,
        walletAddress: users.walletAddress,
      }
    }).from(agents)
      .leftJoin(users, eq(agents.creatorId, users.id))
      .where(eq(agents.agentId, parseInt(agentId)))
      .limit(1);

    if (agent.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Agent not found with the specified smart contract ID'
      });
    }

    res.json({
      success: true,
      agent: agent[0]
    });
  } catch (error) {
    console.error('Get agent by contract ID error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Check if smart contract agent ID exists
app.get('/api/agents/contract-id/:agentId/exists', async (req, res) => {
  try {
    const { agentId } = req.params;

    const agent = await db.select({ id: agents.id })
      .from(agents)
      .where(eq(agents.agentId, parseInt(agentId)))
      .limit(1);

    res.json({
      success: true,
      exists: agent.length > 0,
      agentId: agent.length > 0 ? agent[0].id : null
    });
  } catch (error) {
    console.error('Check contract ID exists error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Route not found'
  });
});

// For Vercel, export the app instead of listening
export default app;

// For local development
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}