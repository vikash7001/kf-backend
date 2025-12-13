Deploy backend:

1) Copy `.env.example` to `.env` and set SQL credentials and PORT.
2) Locally: `npm install` then `npm start`. Ensure the server can reach RDS.
3) To deploy on Render:
   - Create new Web Service -> connect repo -> set build command `npm install`
   - Start command `npm start`
   - Set environment variables in Render from .env
4) Or deploy Docker image to any container service and run with env vars.
