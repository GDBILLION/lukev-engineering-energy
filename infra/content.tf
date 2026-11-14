# Edited website text (services). One small item per service: ndt, equipment, solar.
# A service with no item here simply shows the text that is built into the website.

resource "aws_dynamodb_table" "content" {
  name         = "${local.name}-content"
  billing_mode = "PAY_PER_REQUEST" # no idle cost
  hash_key     = "id"

  attribute {
    name = "id"
    type = "S"
  }

  # Lets you restore the text if it is ever overwritten by mistake.
  point_in_time_recovery {
    enabled = true
  }
}

output "content_table" {
  description = "DynamoDB table holding the edited service text"
  value       = aws_dynamodb_table.content.name
}
