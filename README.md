# CourseWise Admin

A full stack admin app built with Node.js, Express, EJS, and Supabase. The route and template structure follows the `morecrudithink` CRUD example: Express receives form data, server routes access the database, and EJS renders the records.

The app uses CourseWise's existing Supabase Auth accounts and existing `public."User"` and `public."Tasks"` tables. It does not create a separate password table. Only accounts listed in `public.coursewise_admins` can sign in.

## Run locally

1. Install Node.js 20 or newer.
2. In the Supabase dashboard for the CourseWise project, open **Project Settings → API Keys**. Copy the project URL, publishable key, and legacy `service_role` key.
3. Copy `.env.example` to `.env` and fill in those values. Make `SESSION_SECRET` a long random value. Keep the service-role key and `.env` private.
4. Make sure the project's admin allow-list exists. In Supabase SQL Editor, run the existing `supabase/admin-setup.sql` from the main CourseWise app if `public.coursewise_admins` has not been created already.
5. Choose a CourseWise account for grading. The account needs a matching profile in `public."User"` and admin access. Grant access with this SQL, replacing the email:

   ```sql
   insert into public.coursewise_admins (user_id)
   select id from auth.users where lower(email) = lower('grader@example.com')
   on conflict (user_id) do nothing;
   ```

6. Run `npm install`, then `npm start`. Open `http://localhost:3000` and sign in with the grading account.

## Admin features

- **Users:** display, search, sort, create, edit, and delete CourseWise profile records. New users are created as confirmed Supabase Auth users and get a matching profile. Leave the password blank when editing to keep it unchanged.
- **Tasks:** display, search, sort, create, edit, and delete records in the existing `public."Tasks"` table. Tasks can be assigned to a CourseWise user, given a due date, and marked complete.
- **Sign-in:** Supabase Auth verifies the email and password. The app then checks the existing admin allow-list.
- **Session:** a signed, HTTP-only cookie carries the admin ID and email for eight hours. The server checks that the ID is still an admin on each request, so the app does not depend on in-memory sessions that disappear between Vercel Function invocations.
- **Logout:** clears the signed cookie.

## Deploy to Vercel

Vercel can deploy this Express app as a Node.js Function. The app exports the Express instance from `index.js`; `vercel.json` includes the EJS `views/` directory in the Function. Vercel serves files in `public/` directly, so the logos, CSS, and browser JavaScript are available at their current paths.

1. Push this project to a Git repository, or use the Vercel CLI from the project folder. In Vercel, choose **Add New → Project** and import the repository. If the repository contains other folders, set the project **Root Directory** to `coursewise-admin`.
2. In the project settings, add these environment variables for the **Production** environment:
   - `SUPABASE_URL`
   - `SUPABASE_PUBLISHABLE_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SESSION_SECRET` (a fresh, long random string)
3. Keep the service-role key server-side. Do not add a `.env` file to the Git repository or Vercel source upload.
4. Deploy the project. Vercel detects the Express app and deploys `index.js`. The deployment will provide an HTTPS `vercel.app` URL.
5. Open that URL and test sign-in, the user and task pages, and logout. Confirm the grading account is listed in `public.coursewise_admins` and has a matching profile in `public."User"`.
6. Give the TA the Production URL and the grading account credentials.

The Hobby plan is free within its usage limits and is intended for personal, non-commercial projects. If the project exceeds its included limits, Vercel may pause usage until limits reset. Check [Vercel's current Hobby plan details](https://vercel.com/docs/plans/hobby) before deploying.

## Project files

- `index.js` — Express routes, Supabase requests, signed-cookie authentication, and CRUD handling.
- `views/` — EJS pages and shared header/footer templates.
- `public/css/styles.css` — responsive CourseWise styling.
- `public/js/table-tools.js` — client-side table filtering and sorting.
- `public/images/` — CourseWise logo files copied from the main app.
- `vercel.json` — includes runtime EJS templates in the Vercel Function.
- `.env.example` — environment variable names for local development.
