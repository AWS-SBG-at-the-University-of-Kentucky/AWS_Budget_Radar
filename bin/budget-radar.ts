#!/usr/bin/env node
import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { loadConfig } from "../lib/config";
import { BudgetRadarStack } from "../lib/budget-radar-stack";

const config = loadConfig(process.env);
const app = new cdk.App();
new BudgetRadarStack(app, "BudgetRadarStack", {
  config,
  // Environment-agnostic: no live lookups at synth. Account/region resolve at deploy.
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION }
});
app.synth();
