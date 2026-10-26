import { createListConnectionsTool, createManageUserTool, createSetRoleTool } from './admin.js'
import { createCallProcedureTool, createExecuteTool, createQueryTool } from './data.js'
import { createAlterTool, createCreateTool, createDropTool } from './ddl.js'
import { createDescribeObjectTool, createListObjectsTool } from './metadata.js'
import { createGrantTool, createRevokeTool } from './privileges.js'

export function buildTools(context) {
  return [
    createListConnectionsTool(context),
    createQueryTool(context),
    createExecuteTool(context),
    createCallProcedureTool(context),
    createListObjectsTool(context),
    createDescribeObjectTool(context),
    createCreateTool(context),
    createAlterTool(context),
    createDropTool(context),
    createGrantTool(context),
    createRevokeTool(context),
    createSetRoleTool(context),
    createManageUserTool(context),
  ]
}
