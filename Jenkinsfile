/*
 * payments-gateway CI pipeline — job "payments-gateway-main"
 *
 * payments-gateway is the reusable engine (MCP + REST + x402 + hosted AI).
 * It is NOT deployed directly: the live surface ships as a pinned npm
 * dependency of winbit32MCP (github:Rotwang9000/payments-gateway#<sha>).
 *
 * So this pipeline is a CI GATE only — it proves a commit is releasable.
 * Promotion to live is an explicit, reviewable act:
 *   1. this job goes green on main,
 *   2. bump the pin in winbit32MCP/package.json to the new commit and
 *      regenerate the lock (npm install), then push winbit32MCP,
 *   3. the winbit32MCP-master pipeline deploys it (staging -> approval -> live).
 *
 * Node: pinned to the system node (v23, /usr/local/bin) so the native
 * better-sqlite3 build + jest run match the live mcp.winbit32.com runtime
 * (a v21-built binary will not dlopen under v23 and vice-versa).
 */

pipeline {
	agent any

	environment {
		// Match the live runtime (winbit32-rest/mcp run /usr/local/bin/node v23).
		PATH = "/usr/local/bin:${env.PATH}"
		CI   = 'true'
	}

	options {
		buildDiscarder(logRotator(numToKeepStr: '20'))
		timeout(time: 20, unit: 'MINUTES')
		timestamps()
		disableConcurrentBuilds()
	}

	stages {

		stage('Checkout Info') {
			steps {
				sh '''
					echo "Branch:  ${BRANCH_NAME:-$GIT_BRANCH}"
					echo "Commit:  $(git rev-parse --short HEAD || echo n/a)"
					echo "Node:    $(node --version)"
					echo "npm:     $(npm --version)"
				'''
			}
		}

		stage('Install Dependencies') {
			steps {
				// npm ci builds better-sqlite3 against this node and validates
				// the lock is in sync (the same gate the live deploy relies on).
				sh 'npm ci --no-audit --fund=false'
			}
		}

		stage('Test') {
			steps {
				// Full jest suite (ESM needs --experimental-vm-modules, which the
				// package.json `test` script already passes). No pipe to tail:
				// `cmd | tail` would mask a failing suite behind tail's exit code.
				sh 'npm test'
			}
		}

		stage('Security Scans') {
			parallel {
				stage('Dependency Audit') {
					steps {
						// Non-blocking: surfaces criticals without failing the gate
						// on transitive advisories we cannot fix here.
						sh 'npm audit --omit=dev --audit-level=critical 2>&1 | tail -25 || true'
					}
				}
				stage('Secret Scan') {
					steps {
						sh '''
							echo "Scanning src/ for hardcoded secrets..."
							FOUND=$(grep -rnE "(PRIVATE_KEY|mnemonic|password|secret|api_?key)\\s*[:=]\\s*['\\"][^'\\"]+" src/ 2>/dev/null \
								| grep -v "process\\.env" \
								| grep -viE "example|placeholder|<your|test|describe\\(|it\\(" \
								| head -10 || true)
							if [ -n "$FOUND" ]; then
								echo "WARN: potential hardcoded secrets:"; echo "$FOUND"
							else
								echo "No hardcoded secrets detected"
							fi
						'''
					}
				}
			}
		}
	}

	post {
		failure {
			echo "payments-gateway CI FAILED — ${env.BRANCH_NAME ?: env.GIT_BRANCH} build #${env.BUILD_NUMBER}"
		}
		success {
			echo "payments-gateway CI green — ${env.BRANCH_NAME ?: env.GIT_BRANCH} build #${env.BUILD_NUMBER}. " +
			     "To release: bump the pin in winbit32MCP/package.json + npm install + push (triggers winbit32MCP-master)."
		}
	}
}
