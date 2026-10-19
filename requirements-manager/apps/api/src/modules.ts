import {Module} from "@nestjs/common";
import {APP_GUARD} from "@nestjs/core";
import {PrismaService} from "./prisma.js";
import {AuthController, AuthGuard, AuthService} from "./auth.js";
import {ProjectsController, ProjectsService} from "./projects.js";
import {RunsController, RunsService} from "./runs.js";
import {ReviewsController} from "./reviews.js";
import {DocumentsController} from "./documents.js";
import {TraceabilityController, TraceabilityService} from "./traceability.js";
import {ExportsController} from "./exports.js";
import {SettingsController} from "./settings.js";
import {Phase2EditsController, Phase2EditsService} from "./phase2-edits.js";
import {EditTimeController, EditTimeService} from "./edit-time.js";
import {RequirementRevisionsController, RequirementRevisionsService} from "./requirement-revisions.js";
import {DebugFilesController, DebugFilesService} from "./debug-files.js";

@Module({
    controllers: [AuthController, ProjectsController, RunsController, ReviewsController, DocumentsController, TraceabilityController, ExportsController, SettingsController, Phase2EditsController, EditTimeController, RequirementRevisionsController, DebugFilesController],
    providers: [PrismaService, AuthService, ProjectsService, RunsService, TraceabilityService, Phase2EditsService, EditTimeService, RequirementRevisionsService, DebugFilesService, {
        provide: APP_GUARD,
        useClass: AuthGuard
    }]
})
export class AppModule {
}
