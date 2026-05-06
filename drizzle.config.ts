import { defineConfig } from 'drizzle-kit';

export default defineConfig({
    schema: './src/core/db/schema.ts',
    out: './drizzle',
    dialect: 'sqlite',
    dbCredentials: {
        url: './data/tasks.db',
    },
});
