# Admin area for the owner: Cognito login, protected API routes, the admin Lambda,
# and a CloudFront rewrite so https://lukevengineering.com/admin opens the admin page.

############################################
# Cognito: only people you create can sign in
############################################

resource "aws_cognito_user_pool" "admin" {
  name                     = "${local.name}-admin"
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]
  mfa_configuration        = "OFF"
  deletion_protection      = "ACTIVE"

  # No public sign-up: accounts are created by you with the AWS CLI.
  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_uppercase                = true
    require_numbers                  = true
    require_symbols                  = true
    temporary_password_validity_days = 7
  }

  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }
}

# The admin page signs in directly with this app client (no client secret, as for any browser app).
resource "aws_cognito_user_pool_client" "admin" {
  name            = "${local.name}-admin-web"
  user_pool_id    = aws_cognito_user_pool.admin.id
  generate_secret = false

  explicit_auth_flows           = ["ALLOW_USER_PASSWORD_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"
  enable_token_revocation       = true

  id_token_validity      = 60
  access_token_validity  = 60
  refresh_token_validity = 30

  token_validity_units {
    id_token      = "minutes"
    access_token  = "minutes"
    refresh_token = "days"
  }
}

############################################
# API Gateway: protect the admin routes with the Cognito login
############################################

resource "aws_apigatewayv2_authorizer" "admin" {
  api_id           = aws_apigatewayv2_api.site.id
  name             = "cognito-admin"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    audience = [aws_cognito_user_pool_client.admin.id]
    issuer   = "https://${aws_cognito_user_pool.admin.endpoint}"
  }
}

locals {
  # route => needs a login?
  admin_routes = {
    "GET /api/auth-config"             = false # public: tells the admin page which Cognito app to use
    "GET /api/admin/inquiries"         = true
    "PATCH /api/admin/inquiries/{id}"  = true
    "DELETE /api/admin/inquiries/{id}" = true
    "GET /api/content"                 = false # public: the edited service text shown on the website
    "GET /api/admin/content"           = true
    "PUT /api/admin/services/{id}"     = true
    "DELETE /api/admin/services/{id}"  = true
  }
}

resource "aws_apigatewayv2_integration" "admin" {
  api_id                 = aws_apigatewayv2_api.site.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.admin.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "admin" {
  for_each = local.admin_routes

  api_id             = aws_apigatewayv2_api.site.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.admin.id}"
  authorization_type = each.value ? "JWT" : "NONE"
  authorizer_id      = each.value ? aws_apigatewayv2_authorizer.admin.id : null
}

resource "aws_lambda_permission" "admin_api_invoke" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.admin.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.site.execution_arn}/*/*"
}

############################################
# Admin Lambda
############################################

data "archive_file" "admin" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/admin"
  output_path = "${path.module}/.terraform/admin.zip"
  excludes    = ["test.mjs"]
}

resource "aws_cloudwatch_log_group" "admin" {
  name              = "/aws/lambda/${local.name}-admin"
  retention_in_days = 30
}

resource "aws_iam_role" "admin" {
  name               = "${local.name}-admin-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Least privilege: read the index, change or delete enquiries, edit the service text, write its own logs.
data "aws_iam_policy_document" "admin" {
  statement {
    sid       = "ReadEnquiries"
    actions   = ["dynamodb:Query"]
    resources = [aws_dynamodb_table.inquiries.arn, "${aws_dynamodb_table.inquiries.arn}/index/*"]
  }

  statement {
    sid       = "ChangeEnquiries"
    actions   = ["dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.inquiries.arn]
  }

  statement {
    sid       = "EditServiceText"
    actions   = ["dynamodb:Scan", "dynamodb:PutItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.content.arn]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.admin.arn}:*"]
  }
}

resource "aws_iam_role_policy" "admin" {
  name   = "admin-access"
  role   = aws_iam_role.admin.id
  policy = data.aws_iam_policy_document.admin.json
}

resource "aws_lambda_function" "admin" {
  function_name    = "${local.name}-admin"
  role             = aws_iam_role.admin.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = data.archive_file.admin.output_path
  source_code_hash = data.archive_file.admin.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME        = aws_dynamodb_table.inquiries.name
      CONTENT_TABLE     = aws_dynamodb_table.content.name
      COGNITO_REGION    = var.aws_region
      COGNITO_CLIENT_ID = aws_cognito_user_pool_client.admin.id
    }
  }

  depends_on = [aws_cloudwatch_log_group.admin, aws_iam_role_policy.admin]
}

############################################
# CloudFront: /admin opens /admin.html
############################################

# S3 has no folders, so "/admin" would otherwise fall through to the main site.
resource "aws_cloudfront_function" "rewrite" {
  name    = "${local.name}-rewrite"
  runtime = "cloudfront-js-2.0"
  comment = "Open /admin as /admin.html"
  publish = true

  code = <<-EOT
    function handler(event) {
      var request = event.request;
      if (request.uri === "/admin" || request.uri === "/admin/") {
        request.uri = "/admin.html";
      }
      return request;
    }
  EOT
}

############################################
# Outputs
############################################

output "admin_user_pool_id" {
  description = "Cognito user pool for the owner login (needed to create the owner account)"
  value       = aws_cognito_user_pool.admin.id
}

output "admin_client_id" {
  description = "Cognito app client used by the admin page"
  value       = aws_cognito_user_pool_client.admin.id
}

output "admin_url" {
  description = "Where the owner signs in"
  value       = "https://${var.domain_name}/admin"
}
