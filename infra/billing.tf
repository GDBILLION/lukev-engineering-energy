# AWS cost alerts: emails whoever is in var.alert_email (the AWS account owner),
# not the website admin. Covers AWS charges only - Google Workspace and the
# domain registrar bill separately.

variable "budget_amount" {
  description = "Monthly AWS budget limit in USD"
  type        = string
  default     = "15"
}

variable "alert_email" {
  description = "Email address that receives AWS billing alerts"
  type        = string
}

resource "aws_sns_topic" "billing_alerts" {
  name = "lukev-billing-alerts"
}

# AWS sends a confirmation email: click the link or no alerts will arrive.
resource "aws_sns_topic_subscription" "billing_alerts_email" {
  topic_arn = aws_sns_topic.billing_alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_sns_topic_policy" "billing_alerts" {
  arn = aws_sns_topic.billing_alerts.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowBudgetsToPublish"
        Effect    = "Allow"
        Principal = { Service = "budgets.amazonaws.com" }
        Action    = "SNS:Publish"
        Resource  = aws_sns_topic.billing_alerts.arn
      }
    ]
  })
}

resource "aws_budgets_budget" "monthly" {
  name         = "lukev-monthly-budget"
  budget_type  = "COST"
  limit_amount = var.budget_amount
  limit_unit   = "USD"
  time_unit    = "MONTHLY"

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 80
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.billing_alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "ACTUAL"
    subscriber_sns_topic_arns = [aws_sns_topic.billing_alerts.arn]
  }

  notification {
    comparison_operator       = "GREATER_THAN"
    threshold                 = 100
    threshold_type            = "PERCENTAGE"
    notification_type         = "FORECASTED"
    subscriber_sns_topic_arns = [aws_sns_topic.billing_alerts.arn]
  }

  depends_on = [aws_sns_topic_policy.billing_alerts]
}
