CREATE OR REPLACE TRIGGER update_user_updatedAt BEFORE UPDATE ON user FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER update_project_updatedAt BEFORE UPDATE ON project FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER update_task_updatedAt BEFORE UPDATE ON task FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER update_task_comment_updatedAt BEFORE UPDATE ON task_comment FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE OR REPLACE TRIGGER update_time_tracking_entry_updatedAt BEFORE UPDATE ON time_tracking_entry FOR EACH ROW EXECUTE FUNCTION update_updated_at();
