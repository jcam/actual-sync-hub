import "fastify";

declare module "fastify" {
  interface Session {
    user?: {
      id: string;
      username: string;
    };
  }
}
