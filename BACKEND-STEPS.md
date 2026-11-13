# Enquiry backend: what is in this folder

| File | What it does |
|---|---|
| `infra/backend.tf` (new) | DynamoDB table, SES domain identity + DKIM records, Lambda, API Gateway |
| `infra/main.tf` (replaces the old one) | Same as before, plus: CloudFront sends `/api/*` to the API |
| `infra/versions.tf` (replaces the old one) | Same as before, plus the `archive` provider (zips the Lambda) |
| `lambda/inquiries/index.mjs` (new) | The function: checks the form, saves it, emails info@ |
| `lambda/inquiries/test.mjs` (new) | Tests for the function (`node --test lambda/inquiries/test.mjs`) |
| `public/inquiry.js` (new) | Makes the contact form send to `/api/inquiries` |

## Order matters
1. Create a branch, copy the files in.
2. Terraform first (`init`, `plan`, `apply`), so the API exists.
3. Then add the script tag to `public/original.html`, push, pull request, merge (the pipeline deploys).
4. Test on the live site.

If the site is deployed before Terraform runs, the form shows its "Something went wrong" message.

## Expected plan
`Plan: 14 to add, 1 to change, 0 to destroy.`
The "1 to change" is the CloudFront distribution (updated in place, no downtime).

## Notes
- SPF does not need changing. SES mail passes DMARC through its DKIM signature.
- The notification mail comes from `website@lukevengineering.com` and replies go to the customer.
- New SES accounts start in a "sandbox". That is fine here, because mail only goes to `info@` on your own verified domain.
- If spam ever arrives through the form, add a CAPTCHA (for example Cloudflare Turnstile).
