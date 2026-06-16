/**
 * NextAuth.js catch-all route for the App Router.
 *
 * NextAuth v4 supports the App Router by exporting GET / POST handlers from
 * a `route.ts` file. The configuration lives in `src/lib/auth.ts`.
 */

import NextAuth from 'next-auth';
import { authOptions } from '../../../../lib/auth';

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };
