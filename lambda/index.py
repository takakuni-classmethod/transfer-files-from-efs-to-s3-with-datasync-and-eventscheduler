import os
import boto3

def lambda_handler(event,context):
    client = boto3.client('datasync')
    taskArn = os.environ['taskArn']

    response = client.start_task_execution(
        TaskArn = taskArn
    )