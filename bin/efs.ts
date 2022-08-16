#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { EfsStack } from "../lib/efs-stack";

const app = new cdk.App();
new EfsStack(app, "EfsStack");
