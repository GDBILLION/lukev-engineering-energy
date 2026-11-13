# Admin, phase 1: owner login + enquiries screen

| File | What it does |
|---|---|
| `infra/admin.tf` (new) | Cognito login (only accounts you create), protected API routes, admin Lambda, `/admin` address |
| `infra/main.tf` (replaces the old one) | Same as before, plus 6 lines so `/admin` opens the admin page |
| `lambda/admin/index.mjs`, `test.mjs` (new) | List enquiries, mark handled / reopen, delete |
| `public/admin.html`, `admin.css`, `admin.js` (new) | The screens: sign in, choose password, enquiries |

## Order
1. Branch, copy files, check `git status` and `git diff --stat`.
2. Terraform: `plan`, `apply`.
3. Create the owner account (one AWS CLI command).
4. Commit, push, pull request, merge (the pipeline deploys the screens).
5. Open https://lukevengineering.com/admin and sign in.

## Expected plan
`Plan: 14 to add, 1 to change, 0 to destroy.` The one change is CloudFront (in place, no downtime).

## Creating the owner account
```powershell
cd infra
$pool = terraform output -raw admin_user_pool_id
aws cognito-idp admin-create-user --user-pool-id $pool --username info@lukevengineering.com --user-attributes Name=email,Value=info@lukevengineering.com Name=email_verified,Value=true --temporary-password "PICK-A-TEMPORARY-PASSWORD" --message-action SUPPRESS
```
The temporary password needs 12+ characters with upper and lower case, a number and a symbol.
It only works once: the owner chooses a real password at first sign-in.

## If the owner forgets the password
```powershell
aws cognito-idp admin-set-user-password --user-pool-id $pool --username info@lukevengineering.com --password "NEW-TEMPORARY-PASSWORD"
```
(Without `--permanent` it is temporary again, so the owner picks a new one at the next sign-in.)

## Notes
- The admin page is public HTML, but every piece of data comes through the protected API.
- Sessions last 30 days inside one browser tab; closing the tab signs out.
- Not included yet: a second sign-in factor (an authenticator app). Worth adding later.
- Phase 2 (edit services and projects) and phase 3 (photo uploads) come next.
