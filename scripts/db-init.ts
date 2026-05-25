import "dotenv/config";
import {
  createDb,
  seedDefaultSettings,
  seedDefaultWorkflows,
} from "../src/lib/db";

function main(): void {
  const path = process.env.DATABASE_URL;
  if (!path) {
    console.error(
      "DATABASE_URL is not set. Copy .env.example to .env and fill it in."
    );
    process.exit(1);
  }

  console.log(`Initializing database at ${path}...`);
  const db = createDb(path);
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
  db.close();
  console.log("Database initialized. Defaults and built-in workflows seeded.");
}

main();
