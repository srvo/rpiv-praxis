import type { Workflow } from "../api.ts";
import { validateWorkflow } from "../validate-workflow.ts";

/** Return a concise error for the exact workflow object about to be executed. */
export function workflowValidationError(workflow: Workflow): string | undefined {
	const errors = validateWorkflow(workflow).filter((issue) => issue.severity === "error");
	if (errors.length === 0) return undefined;
	return `Workflow "${workflow.name}" failed validation: ${errors.map((issue) => issue.message).join("; ")}`;
}
