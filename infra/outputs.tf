output "site_bucket" {
  description = "S3 bucket the pipeline uploads to"
  value       = aws_s3_bucket.site.bucket
}

output "cloudfront_distribution_id" {
  description = "Used for cache invalidation"
  value       = aws_cloudfront_distribution.site.id
}

output "cloudfront_url" {
  description = "Free address that always works, even before the domain is registered"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "site_url" {
  description = "The address visitors will use"
  value       = var.enable_custom_domain ? "https://${var.domain_name}" : "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "github_deploy_role_arn" {
  description = "Save as the GitHub Actions variable AWS_ROLE_ARN"
  value       = aws_iam_role.deploy.arn
}

output "name_servers" {
  description = "Copy these 4 values into your registrar's nameserver settings (only when create_hosted_zone = true)"
  value       = var.enable_custom_domain && var.create_hosted_zone ? aws_route53_zone.main[0].name_servers : []
}
