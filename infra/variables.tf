variable "aws_region" {
  description = "Region for all resources. Keep us-east-1 (CloudFront certificates must be there)."
  type        = string
  default     = "us-east-1"
}

variable "project" {
  description = "Short project name used in resource names and tags."
  type        = string
  default     = "lukev-site"
}

variable "environment" {
  description = "Environment name."
  type        = string
  default     = "prod"
}

variable "domain_name" {
  description = "The business domain (apex, no www)."
  type        = string
  default     = "lukevengineering.com"
}

variable "enable_custom_domain" {
  description = <<-EOT
    false = serve the site on the free *.cloudfront.net address (use this until the domain is registered).
    true  = request the HTTPS certificate and point lukevengineering.com and www at CloudFront.
  EOT
  type        = bool
  default     = false
}

variable "create_hosted_zone" {
  description = <<-EOT
    Only used when enable_custom_domain = true.
    true  = domain was registered OUTSIDE Route 53 (Namecheap, Whogohost...): Terraform creates the zone,
            and you copy its name servers to the registrar.
    false = domain was registered IN Route 53: AWS already created the zone, Terraform looks it up.
  EOT
  type        = bool
  default     = false
}

variable "github_repo" {
  description = "GitHub repository allowed to deploy, as owner/name (for example corneliusluuiz94/lukev-engineering-energy)."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$", var.github_repo))
    error_message = "github_repo must look like owner/name."
  }
}

variable "github_branch" {
  description = "Only pushes to this branch may deploy."
  type        = string
  default     = "main"
}

variable "create_github_oidc_provider" {
  description = "Set to false if this AWS account already has the GitHub OIDC provider (token.actions.githubusercontent.com)."
  type        = bool
  default     = true
}
