-- Bridge for Annotator's inline comment box: a headless nvim with the person's
-- own config does the editing; the mod sends keys and draws the state below.
--
-- State is pushed to `<socket>.json` from autocmds instead of being queried:
-- an RPC request arriving while a mapping is half typed (the j of jk) would
-- end the mapping and insert the j.
local M = {}
local seq = 0

local function charcol(mark)
  return vim.fn.charcol(mark) - 1
end

--- Everything the comment box draws, as JSON. Columns are character indexes.
function M.state()
  local mode = vim.api.nvim_get_mode()
  local cursor = vim.api.nvim_win_get_cursor(0)
  local state = {
    seq = seq,
    mode = mode.mode,
    timeout = vim.o.timeoutlen,
    lines = vim.api.nvim_buf_get_lines(0, 0, -1, false),
    row = cursor[1] - 1,
    col = charcol("."),
  }
  local kind = mode.mode:sub(1, 1)
  if kind == "v" or kind == "V" or kind == "\22" then
    state.visual = { row = vim.fn.line("v") - 1, col = charcol("v") }
  end
  if kind == "c" then
    state.cmdline = vim.fn.getcmdtype() .. vim.fn.getcmdline()
  end
  return vim.json.encode(state)
end

local function publish()
  seq = seq + 1
  local path = vim.v.servername .. ".json"
  local file = io.open(path .. ".tmp", "w")
  if not file then
    return
  end
  file:write(M.state())
  file:close()
  os.rename(path .. ".tmp", path)
end

vim.api.nvim_create_autocmd({
  "ModeChanged", "TextChanged", "TextChangedI", "TextChangedP", "CursorMoved", "CursorMovedI",
  "CmdlineEnter", "CmdlineChanged",
}, { callback = publish })

--- Starts a fresh comment buffer holding `text`, cursor at its end, in normal mode.
function M.load(text)
  vim.api.nvim_feedkeys(vim.keycode("<C-\\><C-n>"), "nx", false)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_set_current_buf(buf)
  vim.bo[buf].bufhidden = "wipe"
  vim.bo[buf].filetype = "markdown"
  -- The loaded draft is the starting point, not an undoable change.
  local levels = vim.bo[buf].undolevels
  vim.bo[buf].undolevels = -1
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(text, "\n", { plain = true }))
  vim.bo[buf].undolevels = levels
  local last = vim.api.nvim_buf_line_count(buf)
  local line = vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1]
  vim.api.nvim_win_set_cursor(0, { last, math.max(0, #line - 1) })
  publish()
  return M.state()
end

_G.AnnotatorBridge = M

-- Without a UI, lazy.nvim never fires VeryLazy, where LazyVim sets keymaps
-- (like jk) and the system clipboard. Fire it once startup has finished.
local function very_lazy()
  vim.schedule(function()
    pcall(vim.api.nvim_exec_autocmds, "User", { pattern = "VeryLazy", modeline = false })
  end)
end
if vim.v.vim_did_enter == 1 then
  very_lazy()
else
  vim.api.nvim_create_autocmd("VimEnter", { once = true, callback = very_lazy })
end
