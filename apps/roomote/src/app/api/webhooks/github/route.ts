import { NextRequest, NextResponse } from "next/server"
import { createHmac } from "crypto"
import { z } from "zod"
import { eq } from "drizzle-orm"

import { type JobType, type JobPayload, githubIssueWebhookSchema, githubPullRequestWebhookSchema } from "@/types"
import { db, cloudJobs } from "@/db"
import { enqueue } from "@/lib"
import { SlackNotifier } from "@/lib/slack"

function verifySignature(body: string, signature: string, secret: string): boolean {
	const expectedSignature = createHmac("sha256", secret).update(body, "utf8").digest("hex")
	const receivedSignature = signature.replace("sha256=", "")
	return expectedSignature === receivedSignature
}

async function handleIssueEvent(body: string) {
	const data = githubIssueWebhookSchema.parse(JSON.parse(body))
	const { action, repository, issue } = data

	if (action !== "opened") {
		return NextResponse.json({ message: "action_ignored" })
	}

	console.log("🗄️ Issue Webhook ->", data)

	const type: JobType = "github.issue.fix"

	const payload: JobPayload<typeof type> = {
		repo: repository.full_name,
		issue: issue.number,
		title: issue.title,
		body: issue.body || "",
		labels: issue.labels.map(({ name }) => name),
	}

	const [job] = await db.insert(cloudJobs).values({ type, payload, status: "pending" }).returning()

	if (!job) {
		throw new Error("Failed to create `cloudJobs` record.")
	}

	const enqueuedJob = await enqueue({ jobId: job.id, type, payload })
	console.log("🔗 Enqueued job ->", enqueuedJob)

	return NextResponse.json({ message: "job_enqueued", jobId: job.id, enqueuedJobId: enqueuedJob.id })
}

async function handlePullRequestEvent(body: string) {
	const data = githubPullRequestWebhookSchema.parse(JSON.parse(body))
	const { action, pull_request, repository } = data

	if (action !== "opened") {
		return NextResponse.json({ message: "action_ignored" })
	}

	console.log("🗄️ PR Webhook ->", data)

	// Extract issue number from PR title or body (looking for "Fixes #123" pattern).
	const issueNumberMatch =
		pull_request.title.match(/(?:fixes|closes|resolves)\s+#(\d+)/i) ||
		(pull_request.body && pull_request.body.match(/(?:fixes|closes|resolves)\s+#(\d+)/i))

	if (!issueNumberMatch) {
		return NextResponse.json({ message: "no_issue_reference_found" })
	}

	const issueNumber = parseInt(issueNumberMatch[1]!, 10)

	// Find the job that corresponds to this issue.
	const jobs = await db.select().from(cloudJobs).where(eq(cloudJobs.type, "github.issue.fix"))

	// Filter jobs to find the one matching this repo and issue.
	const job = jobs.find((j) => {
		const payload = j.payload as { repo: string; issue: number }
		return payload.repo === repository.full_name && payload.issue === issueNumber
	})

	if (!job || !job.slackThreadTs) {
		console.log("No job found or no slack thread for issue", issueNumber)
		return NextResponse.json({ message: "no_job_or_slack_thread_found" })
	}

	// Post to Slack thread.
	const slackNotifier = new SlackNotifier()

	await slackNotifier.postTaskUpdated(
		job.slackThreadTs,
		`🎉 Pull request created: <${pull_request.html_url}|PR #${pull_request.number}>\n*${pull_request.title}*`,
		"success",
	)

	return NextResponse.json({ message: "slack_notification_sent" })
}

export async function POST(request: NextRequest) {
	try {
		const signature = request.headers.get("x-hub-signature-256")

		if (!signature) {
			return NextResponse.json({ error: "missing_signature" }, { status: 400 })
		}

		const body = await request.text()

		if (!verifySignature(body, signature, process.env.GH_WEBHOOK_SECRET!)) {
			return NextResponse.json({ error: "invalid_signature" }, { status: 401 })
		}

		const event = request.headers.get("x-github-event")

		if (event === "issues") {
			return await handleIssueEvent(body)
		} else if (event === "pull_request") {
			return await handlePullRequestEvent(body)
		} else {
			return NextResponse.json({ message: "event_ignored" })
		}
	} catch (error) {
		console.error("GitHub Webhook Error:", error)

		if (error instanceof z.ZodError) {
			return NextResponse.json({ error: "bad_request", details: error.errors }, { status: 400 })
		}

		return NextResponse.json({ error: "internal_server_error" }, { status: 500 })
	}
}
