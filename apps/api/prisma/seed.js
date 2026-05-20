require('dotenv/config');
const { hash } = require('bcryptjs');
const { PrismaLibSql } = require('@prisma/adapter-libsql');
const { PrismaClient } = require('@prisma/client');

const url = process.env.DATABASE_URL ?? 'file:./dev.db';
const adapter = new PrismaLibSql({ url });
const prisma = new PrismaClient({ adapter });

async function main() {
  const email = (process.env.SEED_USER_EMAIL ?? 'user@example.com').toLowerCase();
  const password = process.env.SEED_USER_PASSWORD ?? 'secret123';
  const name = process.env.SEED_USER_NAME ?? 'Demo User';

  const passwordHash = await hash(password, 10);

  await prisma.user.upsert({
    where: { email },
    update: { name, passwordHash },
    create: { email, name, passwordHash },
  });

  console.log(`Seeded user: ${email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
