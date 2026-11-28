import { NextResponse, type NextRequest } from 'next/server'
import { isAdminRequestAuthenticated, unauthorizedAdminResponse } from '@/lib/admin-auth-server'
import { approveSurah, refreshSurah, removeSurah, serializeSurah } from '@/lib/listen-qaris-server'
import type { ListenSurah, Prisma } from '@prisma/client'
import type { ListenSurahReport } from '@/lib/listen-qaris'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

async function find(id: string) {
  if (!/^[a-f0-9]{24}$/.test(id)) return null
  return prisma.listenSurah.findUnique({ where: { id } })
}

/** GET /api/admin/listen-qaris/surahs/:surahId — the upload, with how far its check has got. */
export async function GET(req: NextRequest, context: { params: Promise<{ surahId: string }> }) {
  if (!(await isAdminRequestAuthenticated(req))) return unauthorizedAdminResponse()
  const row = await find((await context.params).surahId)
  if (!row) return NextResponse.json({ error: 'No such upload.' }, { status: 404 })
  return NextResponse.json(serializeSurah(await refreshSurah(row)))
}

/**
 * POST …/:surahId { action: "approve" | "reject" | "failed" | "mark", error?, marks? } — the admin's
 * decision; the admin's browser saying the file never got through to the check; or ayat the check
 * missed, marked by hand (`marks`: ayah number → seconds into the saved recording).
 */
export async function POST(req: NextRequest, context: { params: Promise<{ surahId: string }> }) {
  if (!(await isAdminRequestAuthenticated(req))) return unauthorizedAdminResponse()
  const row = await find((await context.params).surahId)
  if (!row) return NextResponse.json({ error: 'No such upload.' }, { status: 404 })
  const body = (await req.json().catch(() => ({}))) as { action?: unknown; error?: unknown; marks?: unknown }
  const { action, error } = body
  if (action === 'approve') {
    if (row.status !== 'checked' && row.status !== 'rejected') {
      return NextResponse.json({ error: 'Wait for the check to finish.' }, { status: 409 })
    }
    return NextResponse.json(serializeSurah(await approveSurah(row)))
  }
  if (action === 'reject') {
    if (row.status !== 'checked' && row.status !== 'approved') return NextResponse.json({ error: 'Nothing to reject yet.' }, { status: 409 })
    return NextResponse.json(serializeSurah(await prisma.listenSurah.update({ where: { id: row.id }, data: { status: 'rejected' } })))
  }
  if (action === 'mark') return markAyat(row, body.marks)
  if (action === 'failed' && row.status === 'uploading') {
    const message = String(error ?? '').slice(0, 300) || 'The upload did not get through.'
    return NextResponse.json(serializeSurah(await prisma.listenSurah.update({ where: { id: row.id }, data: { status: 'failed', error: message } })))
  }
  return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
}

/** DELETE …/:surahId — removes the upload and its file. */
export async function DELETE(req: NextRequest, context: { params: Promise<{ surahId: string }> }) {
  if (!(await isAdminRequestAuthenticated(req))) return unauthorizedAdminResponse()
  const row = await find((await context.params).surahId)
  if (!row) return NextResponse.json({ error: 'No such upload.' }, { status: 404 })
  await removeSurah(row)
  return NextResponse.json({ ok: true })
}

/**
 * Ayat the check could not find, placed by the admin: each starts where they marked it and runs to
 * the next ayah's start (the last to the recording's end). A mark must fall between the ayat on
 * either side of it.
 */
async function markAyat(row: ListenSurah, marks: unknown) {
  if (!['checked', 'approved', 'rejected'].includes(row.status)) {
    return NextResponse.json({ error: 'Wait for the check to finish.' }, { status: 409 })
  }
  const report = row.report as unknown as ListenSurahReport | null
  if (!report || !marks || typeof marks !== 'object') return NextResponse.json({ error: 'Nothing to mark.' }, { status: 400 })
  const durationMs = Math.round(report.durationSec * 1000)
  const starts = new Map<number, number>()
  for (const [key, [from]] of Object.entries((row.timings ?? {}) as Record<string, [number, number]>)) {
    starts.set(Number(key.split(':')[1]), from)
  }
  const marked: number[] = []
  for (const [ayahText, seconds] of Object.entries(marks as Record<string, unknown>)) {
    const ayah = Number(ayahText)
    const at = Math.round(Number(seconds) * 1000)
    if (!Number.isInteger(ayah) || ayah < 1 || ayah > report.ayahs.expected || !Number.isFinite(at) || at < 0 || at >= durationMs) {
      return NextResponse.json({ error: `Ayah ${ayahText}: that time is outside the recording.` }, { status: 400 })
    }
    starts.set(ayah, at)
    marked.push(ayah)
  }
  const order = [...starts.entries()].sort((a, b) => a[0] - b[0])
  for (let i = 1; i < order.length; i++) {
    if (order[i][1] <= order[i - 1][1]) {
      const [ayah] = order[i]
      const clock = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
      return NextResponse.json(
        { error: `Ayah ${ayah} must start after ayah ${order[i - 1][0]} (${clock(order[i - 1][1])}).` },
        { status: 400 }
      )
    }
  }
  const timings: Record<string, [number, number]> = {}
  order.forEach(([ayah, from], i) => {
    timings[`${row.surah}:${ayah}`] = [from, i + 1 < order.length ? order[i + 1][1] : durationMs]
  })
  const nextReport: ListenSurahReport = {
    ...report,
    ayahs: {
      ...report.ayahs,
      found: order.length,
      missing: report.ayahs.missing.filter((a) => !starts.has(a)),
      unclear: report.ayahs.unclear.filter((a) => !marked.includes(a)),
    },
    marked: [...new Set([...(report.marked ?? []), ...marked])].sort((a, b) => a - b),
  }
  const saved = await prisma.listenSurah.update({
    where: { id: row.id },
    data: {
      timings: timings as unknown as Prisma.InputJsonValue,
      report: nextReport as unknown as Prisma.InputJsonValue,
    },
  })
  return NextResponse.json(serializeSurah(saved))
}
