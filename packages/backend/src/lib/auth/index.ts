/**
 * Authentication and security primitives for the backend.
 *
 * This module aggregates the underlying building blocks (password hashing,
 * JWT signing, AES-256 encryption, account lockout) used by `AuthService`
 * and the Fastify auth middleware. Consumers should generally import from
 * this barrel rather than reaching into individual files.
 */

export * from './password';
export * from './jwt';
export * from './encryption';
export * from './lockout';
