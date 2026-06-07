{{/*
Reusable template helpers. Naming follows the Helm chart-skeleton conventions so a
caller who's read any other Bitnami / charts.io chart can navigate this one in
seconds.
*/}}

{{- define "arc.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name. Truncated to 63 chars (Kubernetes label limit) and the
trailing `-` is stripped so the result is a valid DNS label even when the truncate
landed mid-token.
*/}}
{{- define "arc.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "arc.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Standard recommended labels applied to every resource. */}}
{{- define "arc.labels" -}}
helm.sh/chart: {{ include "arc.chart" . }}
{{ include "arc.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- with .Values.commonLabels }}
{{ toYaml . }}
{{- end }}
{{- end -}}

{{- define "arc.selectorLabels" -}}
app.kubernetes.io/name: {{ include "arc.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{/* arc-server-specific labels. Used by Deployment + Service to select correctly. */}}
{{- define "arc.server.selectorLabels" -}}
{{ include "arc.selectorLabels" . }}
app.kubernetes.io/component: arc-server
{{- end -}}

{{- define "arc.server.fullname" -}}
{{- printf "%s-server" (include "arc.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* OpenBao name + selector. */}}
{{- define "arc.openbao.fullname" -}}
{{- printf "%s-openbao" (include "arc.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arc.openbao.selectorLabels" -}}
{{ include "arc.selectorLabels" . }}
app.kubernetes.io/component: openbao
{{- end -}}

{{/*
Secret name: either the user-supplied existing one (when create=false) or the chart's
generated name. Centralized so Deployment + ServiceMonitor / Ingress reference the
same identifier without each template hand-rolling it.
*/}}
{{- define "arc.server.secretName" -}}
{{- if and .Values.arcServer.secret.existingSecret (not .Values.arcServer.secret.create) -}}
{{- .Values.arcServer.secret.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "arc.server.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Cluster-internal base URL of arc-server. Components that talk to arc-server (operator,
mcp-server) default to this when `arcServerUrl` is empty, so a single-chart install wires
itself with no extra config.
*/}}
{{- define "arc.server.internalUrl" -}}
{{- printf "http://%s:%v" (include "arc.server.fullname" .) .Values.arcServer.service.port -}}
{{- end -}}

{{/* ----- arc-mcp-server ----- */}}
{{- define "arc.mcp.fullname" -}}
{{- printf "%s-mcp-server" (include "arc.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arc.mcp.selectorLabels" -}}
{{ include "arc.selectorLabels" . }}
app.kubernetes.io/component: arc-mcp-server
{{- end -}}

{{/* ----- arc-operator ----- */}}
{{- define "arc.operator.fullname" -}}
{{- printf "%s-operator" (include "arc.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "arc.operator.selectorLabels" -}}
{{ include "arc.selectorLabels" . }}
app.kubernetes.io/component: arc-operator
{{- end -}}

{{- define "arc.operator.serviceAccountName" -}}
{{- if .Values.operator.serviceAccount.create -}}
{{- default (include "arc.operator.fullname" .) .Values.operator.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.operator.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* ----- arc-agent (sample config only) ----- */}}
{{- define "arc.agent.fullname" -}}
{{- printf "%s-agent" (include "arc.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
