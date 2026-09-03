import { errorResponse, readJson } from "@/lib/api";
import { parseDateParam, todayIso } from "@/lib/attendance";
import { currentActor } from "@/lib/auth";
import { holidayInputFrom } from "@/lib/holiday-input";
import { createHoliday, listHolidays } from "@/lib/holiday-service";
import { parseYearParam } from "@/lib/holidays";
import { HttpError, requireActor } from "@/lib/rbac";

/**
 * The organization's holiday calendar.
 *
 * A MEMBER sees their own region plus the organization-wide entries; the
 * region narrowing is applied in lib/holiday-service.ts, not here.
 */
export async function GET(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const params = new URL(request.url).searchParams;

    const from = params.get("from");
    const to = params.get("to");
    if (Boolean(from) !== Boolean(to)) {
      throw new HttpError(400, 'Pass both "from" and "to", or neither.');
    }

    return Response.json(
      await listHolidays(actor, {
        // A year is the common case, so it defaults rather than being required.
        year: from
          ? undefined
          : parseYearParam(params.get("year") ?? todayIso().slice(0, 4)),
        from: from ? parseDateParam(from, "from") : undefined,
        to: to ? parseDateParam(to, "to") : undefined,
        regionId: params.get("region")?.trim() || undefined,
      }),
    );
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const actor = requireActor(await currentActor());
    const body = await readJson(request);

    return Response.json(await createHoliday(actor, holidayInputFrom(body)), {
      status: 201,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
