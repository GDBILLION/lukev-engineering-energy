# LUKEV site: hosting infrastructure (us-east-1)

Private S3 bucket, CloudFront (HTTPS, security headers, SPA-friendly errors), optional Route 53 + ACM for
`lukevengineering.com`, a GitHub Actions deploy role (OIDC, no stored keys), and an AWS cost alarm.

## Where the files go
Copy into the root of the cloned repo (`lukev-engineering-energy`):

```
infra/                       <- Terraform
.github/workflows/deploy.yml <- pipeline
```
Then append `gitignore-additions.txt` to `.gitignore` **before** running Terraform.

## One-time setup (PowerShell)

```powershell
aws sts get-caller-identity          # confirm you are in the right account (316762121840)
```

### 1. Create the state bucket
```powershell
cd infra\bootstrap
terraform init
terraform apply
```
It prints `state_bucket` (expected: `lukev-tfstate-316762121840`). If the name differs, edit the
`bucket` line in `infra/versions.tf` to match. Keep the `terraform.tfstate` file in this folder, but never commit it.

### 2. Create the site
```powershell
cd ..
copy terraform.tfvars.example terraform.tfvars   # then edit: github_repo, alert_email
terraform init
terraform plan
terraform apply
```
Outputs you need: `site_bucket`, `cloudfront_distribution_id`, `github_deploy_role_arn`, `cloudfront_url`.

If apply says the GitHub OIDC provider already exists, set `create_github_oidc_provider = false` and run again.
Confirm the subscription email from AWS, or the budget alerts will not reach you.

### 3. Give GitHub the three values
Repo on GitHub -> Settings -> Secrets and variables -> Actions -> **Variables** tab -> New repository variable:

| Name | Value |
|---|---|
| `AWS_ROLE_ARN` | output `github_deploy_role_arn` |
| `SITE_BUCKET` | output `site_bucket` |
| `CLOUDFRONT_DISTRIBUTION_ID` | output `cloudfront_distribution_id` |

These are not secrets (the role only trusts your repo and branch), so use Variables, not Secrets.

### 4. Deploy
Push to `main`, or run the workflow by hand from the Actions tab.
Open the `cloudfront_url` output. The LUKEV page should load.

## Switching on lukevengineering.com (after it is registered)

Register it in the **owner's name**, with auto-renew and WHOIS privacy on.

**If registered in Route 53** (zone already exists):
1. In `terraform.tfvars`: `enable_custom_domain = true`, `create_hosted_zone = false`
2. `terraform apply` (the certificate validates in a few minutes)

**If registered elsewhere** (Namecheap, Whogohost...):
1. In `terraform.tfvars`: `enable_custom_domain = true`, `create_hosted_zone = true`
2. Create only the zone first: `terraform apply -target=aws_route53_zone.main`
3. Copy the 4 `name_servers` values into the registrar's nameserver settings
4. Wait until they have propagated (check at https://dnschecker.org, can take minutes to 48 hours)
5. `terraform apply` for the rest. If you skip step 4 the certificate validation waits and times out.

Both `lukevengineering.com` and `www.lukevengineering.com` then serve the site over HTTPS.

## Check it works
- Page loads on the CloudFront URL, and on the domain once enabled
- A push to `main` updates the live site (give it a minute, the cache is invalidated by the pipeline)
- `aws s3 ls s3://<site_bucket>` works for you, but opening the bucket URL directly in a browser is refused (private by design)

## Notes
- The deploy role can only write to this bucket and invalidate this distribution.
- `public/original.html` is the actual website (the React app wraps it in an iframe), so do not delete it.
- Terraform state lives in the S3 bucket from step 1 (versioned, encrypted, with native locking).
- Next phases (not in this folder yet): Google Workspace DNS records, DynamoDB, Lambda + API Gateway, Cognito, media bucket.
