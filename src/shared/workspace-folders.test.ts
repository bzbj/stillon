import {expect,test} from "bun:test"
import {workspaceFolderNameError} from "./workspace-folders"

test("workspace folder names preserve natural language on both host platforms",()=>{
  for(const separator of ["/","\\"] as const){
    for(const name of ["财务分析","Quarterly review 2026","旅行计划"]){expect(workspaceFolderNameError(name,separator)).toBeNull()}
    for(const name of ["..",".","a/b"," "]){expect(workspaceFolderNameError(name,separator)).not.toBeNull()}
  }
})
test("Windows reserved names are rejected without restricting valid POSIX names",()=>{
  for(const name of ["CON","NUL.txt","com1","a:b","budget.","a\\b"]){expect(workspaceFolderNameError(name,"\\")).not.toBeNull()}
  expect(workspaceFolderNameError("quarter:one","/")).toBeNull()
})
