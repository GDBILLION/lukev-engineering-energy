terraform {
  required_version = ">= 1.10"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.81, < 7.0"
    }

    # Zips the Lambda code in lambda/inquiries
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }

  # Backend blocks cannot use variables. The bucket name must match the
  # "state_bucket" output printed by infra/bootstrap (lukev-tfstate-<account-id>).
  backend "s3" {
    bucket       = "lukev-tfstate-316762121840"
    key          = "lukev-site/terraform.tfstate"
    region       = "us-east-1"
    encrypt      = true
    use_lockfile = true # S3-native locking, no DynamoDB table needed (Terraform 1.10+)
  }
}

# Everything lives in us-east-1. CloudFront certificates must be requested
# there anyway, so a single provider is enough.
provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Project     = var.project
      Environment = var.environment
      ManagedBy   = "terraform"
    }
  }
}
