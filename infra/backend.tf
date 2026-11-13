# Enquiry backend: DynamoDB table, Lambda, API Gateway (HTTP API) and SES.
# CloudFront sends /api/* to the API (see main.tf), so the website and the API share one address.

############################################
# Settings
############################################

variable "notify_email" {
  description = "Mailbox that receives a notification for every website enquiry."
  type        = string
  default     = "info@lukevengineering.com"
}

variable "ses_from_address" {
  description = "Sender of the notification emails. Must be an address on the verified domain."
  type        = string
  default     = "website@lukevengineering.com"
}

############################################
# DynamoDB: one item per enquiry
############################################

resource "aws_dynamodb_table" "inquiries" {
  name         = "${local.name}-inquiries"
  billing_mode = "PAY_PER_REQUEST" # no idle cost, pennies at this volume
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  attribute {
    name = "status"
    type = "S"
  }

  attribute {
    name = "createdAt"
    type = "S"
  }

  # Lets the future admin panel list "new" enquiries, newest first.
  global_secondary_index {
    name            = "status-createdAt-index"
    hash_key        = "status"
    range_key       = "createdAt"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = true
  }

  deletion_protection_enabled = true
}

############################################
# SES: send from the company domain
############################################

resource "aws_sesv2_email_identity" "domain" {
  email_identity = var.domain_name

  # Easy DKIM: SES signs outgoing mail, which also satisfies DMARC alignment.
  dkim_signing_attributes {
    next_signing_key_length = "RSA_2048_BIT"
  }

  lifecycle {
    precondition {
      condition     = var.enable_custom_domain
      error_message = "The enquiry backend needs enable_custom_domain = true (SES verifies the domain through Route 53)."
    }
  }
}

# Three CNAME records prove to SES that the domain is yours and switch on DKIM.
resource "aws_route53_record" "ses_dkim" {
  count = 3

  zone_id = local.zone_id
  name    = "${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}._domainkey.${var.domain_name}"
  type    = "CNAME"
  ttl     = 600
  records = ["${aws_sesv2_email_identity.domain.dkim_signing_attributes[0].tokens[count.index]}.dkim.amazonses.com"]
}

############################################
# Lambda
############################################

data "archive_file" "inquiries" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda/inquiries"
  output_path = "${path.module}/.terraform/inquiries.zip"
  excludes    = ["test.mjs"]
}

resource "aws_cloudwatch_log_group" "inquiries" {
  name              = "/aws/lambda/${local.name}-inquiries"
  retention_in_days = 30
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]

    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "inquiries" {
  name               = "${local.name}-inquiries-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# Least privilege: write one table, send from one identity, write its own logs.
data "aws_iam_policy_document" "inquiries" {
  statement {
    sid       = "SaveEnquiry"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.inquiries.arn]
  }

  statement {
    sid       = "SendNotification"
    actions   = ["ses:SendEmail"]
    resources = [aws_sesv2_email_identity.domain.arn]
  }

  statement {
    sid       = "WriteLogs"
    actions   = ["logs:CreateLogStream", "logs:PutLogEvents"]
    resources = ["${aws_cloudwatch_log_group.inquiries.arn}:*"]
  }
}

resource "aws_iam_role_policy" "inquiries" {
  name   = "inquiries-access"
  role   = aws_iam_role.inquiries.id
  policy = data.aws_iam_policy_document.inquiries.json
}

resource "aws_lambda_function" "inquiries" {
  function_name    = "${local.name}-inquiries"
  role             = aws_iam_role.inquiries.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"] # cheaper than x86
  handler          = "index.handler"
  filename         = data.archive_file.inquiries.output_path
  source_code_hash = data.archive_file.inquiries.output_base64sha256
  memory_size      = 256
  timeout          = 10

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.inquiries.name
      NOTIFY_TO  = var.notify_email
      SES_FROM   = "LUKEV Website <${var.ses_from_address}>"
    }
  }

  depends_on = [aws_cloudwatch_log_group.inquiries, aws_iam_role_policy.inquiries]
}

############################################
# API Gateway (HTTP API): POST /api/inquiries
############################################

resource "aws_apigatewayv2_api" "site" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "inquiries" {
  api_id                 = aws_apigatewayv2_api.site.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.inquiries.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "inquiries" {
  api_id    = aws_apigatewayv2_api.site.id
  route_key = "POST /api/inquiries"
  target    = "integrations/${aws_apigatewayv2_integration.inquiries.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.site.id
  name        = "$default"
  auto_deploy = true

  # Caps abuse: about 5 requests per second, bursts of 10, across the whole API.
  default_route_settings {
    throttling_rate_limit  = 5
    throttling_burst_limit = 10
  }
}

resource "aws_lambda_permission" "api_invoke" {
  statement_id  = "AllowApiGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.inquiries.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.site.execution_arn}/*/*"
}

############################################
# Outputs
############################################

output "inquiries_table" {
  description = "DynamoDB table holding the enquiries"
  value       = aws_dynamodb_table.inquiries.name
}

output "inquiries_lambda" {
  description = "Lambda function that handles the form"
  value       = aws_lambda_function.inquiries.function_name
}

output "api_endpoint" {
  description = "Direct API address (the website uses /api/inquiries on its own domain instead)"
  value       = aws_apigatewayv2_api.site.api_endpoint
}
