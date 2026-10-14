import { getAppContext } from "@/server/context";
import { dispatch } from "@/server/api/handlers";
import { errorResponse } from "@/server/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request): Promise<Response> {
  try {
    return await dispatch(await getAppContext(), req);
  } catch (e) {
    return errorResponse(e);
  }
}

export { handle as GET, handle as POST, handle as DELETE };
