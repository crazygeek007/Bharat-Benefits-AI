import 'dotenv/config';
import prisma from '../lib/prisma';

async function clean() {
  const result = await prisma.scheme.deleteMany({
    where: { NOT: { sourceUrl: { contains: '#' } } },
  });
  console.log('Deleted', result.count, 'old schemes (without slug fragment)');
  const total = await prisma.scheme.count();
  console.log('Remaining schemes:', total);
}

clean()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
