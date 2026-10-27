// Charge server/.env quel que soit le dossier d'où le serveur est lancé
// (« npm run dev » à la racine lisait sinon le .env de la racine, sans DATABASE_URL)
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('.env', import.meta.url)) });
