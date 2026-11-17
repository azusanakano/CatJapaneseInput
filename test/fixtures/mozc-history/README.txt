tip_edit_session_impl.cc is copied from google/mozc commit
a4541df29db443b49f81cf54665873b68fde9efa, src/win32/tip/tip_edit_session_impl.cc.
The upstream BSD license is retained in the file.

context-history.test.ps1 applies the real TSF patch to an isolated copy and
compiles its OnEndEdit method. Only the downstream composition/UI handling
and TSF-provided context/edit-record objects are replaced. The Windows SDK
supplies the COM interface definitions and the RAII COM pointer used by the
extracted method. No real text store, installed IME, or user setting changes.
